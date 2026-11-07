// Server-only MEGA client (via the `megajs` package). NEVER import this from
// a client component -- it reads MEGA_ACCOUNTS (email + password) from
// process.env. Mirrors pcloudServer.ts / b2Server.ts: accounts are a JSON
// array, so adding another MEGA account is an env var change only.
//
// Unlike B2, MEGA reports live usage (getAccountInfo), so no ledger is
// needed -- it behaves like pCloud for quota purposes.
//
// Everything stored here is opaque ciphertext already encrypted client-side;
// MEGA's own encryption is an extra layer, not what protects the vault.
import { Storage } from "megajs";

// Object layout inside each account, matching the pCloud folders / B2 prefixes.
export const OBJECTS_FOLDER = "vault";
export const THUMBS_FOLDER = "vault-thumbs";

export interface MegaAccount {
  name: string;
  email: string;
  password: string;
  quotaBytes?: number; // optional cap below what MEGA reports
}

export function loadAccounts(): MegaAccount[] {
  const raw = process.env.MEGA_ACCOUNTS;
  if (!raw) return []; // MEGA is optional
  const parsed = JSON.parse(raw) as MegaAccount[];
  if (!Array.isArray(parsed)) {
    throw new Error("MEGA_ACCOUNTS must be a JSON array");
  }
  return parsed;
}

export function accountByName(name: string): MegaAccount | undefined {
  return loadAccounts().find((a) => a.name === name);
}

// Logging in is slow (key derivation + a few round trips) and MEGA throttles
// repeated logins, so keep one session per account in module scope. It
// survives across warm invocations; a cold start just logs in again.
const sessions = new Map<string, Promise<Storage>>();

function session(account: MegaAccount): Promise<Storage> {
  let s = sessions.get(account.name);
  if (!s) {
    s = new Storage({ email: account.email, password: account.password, keepalive: false }).ready;
    sessions.set(account.name, s);
    // A failed login must not be cached forever.
    s.catch(() => sessions.delete(account.name));
  }
  return s;
}

// The local file tree is a snapshot (keepalive is off, so server-side changes
// from other instances/devices never reach it, and deletes don't prune it).
// Every lookup that misses reloads the tree once before giving up, and
// deletes reload afterwards so a later lookup can't hit a ghost entry.
async function folderOf(account: MegaAccount, folderName: string, create: boolean) {
  const storage = await session(account);
  const find = () => storage.root.children?.find((c) => c.directory && c.name === folderName);
  let existing = find();
  if (!existing) {
    await storage.reload(true);
    existing = find();
  }
  if (existing) return existing;
  return create ? storage.root.mkdir(folderName) : null;
}

export async function getQuota(account: MegaAccount): Promise<{ quota: number; usedquota: number }> {
  const storage = await session(account);
  const info = await storage.getAccountInfo();
  const quota = account.quotaBytes ? Math.min(account.quotaBytes, info.spaceTotal) : info.spaceTotal;
  return { quota, usedquota: info.spaceUsed };
}

function findFile(folder: { children?: { directory: boolean; name: string | null }[] }, filename: string) {
  return folder.children?.filter((c) => !c.directory && c.name === filename) ?? [];
}

// Replaces any existing file of the same name (MEGA otherwise keeps
// duplicates, which would still count against the quota).
export async function uploadFile(
  account: MegaAccount,
  folderName: string,
  filename: string,
  bytes: Uint8Array
): Promise<void> {
  const folder = (await folderOf(account, folderName, true))!;
  const old = findFile(folder, filename) as typeof folder.children;
  await folder.upload({ name: filename, size: bytes.length }, Buffer.from(bytes)).complete;
  for (const f of old ?? []) await f.delete(true);
  if (old?.length) await (await session(account)).reload(true);
}

export function uploadCiphertext(account: MegaAccount, filename: string, buffer: Buffer): Promise<void> {
  return uploadFile(account, OBJECTS_FOLDER, filename, buffer);
}

// Returns null when the file doesn't exist so callers can map it to 404.
export async function downloadFile(account: MegaAccount, folderName: string, filename: string): Promise<Buffer | null> {
  const storage = await session(account);
  for (let attempt = 0; attempt < 2; attempt++) {
    const folder = await folderOf(account, folderName, false);
    const file = folder ? findFile(folder, filename)[0] : undefined;
    if (!file) {
      if (attempt === 0) {
        await storage.reload(true); // maybe added elsewhere since our snapshot
        continue;
      }
      return null;
    }
    try {
      return await (file as unknown as { downloadBuffer(o: object): Promise<Buffer> }).downloadBuffer({});
    } catch {
      // Stale entry (deleted elsewhere): refresh and look once more.
      await storage.reload(true);
    }
  }
  return null;
}

export function fetchObjectCiphertext(account: MegaAccount, filename: string): Promise<Buffer | null> {
  return downloadFile(account, OBJECTS_FOLDER, filename);
}

// Permanently deletes (not trash, which still counts against quota). Returns
// bytes freed, 0 if there was nothing to delete.
export async function deleteFile(account: MegaAccount, folderName: string, filename: string): Promise<number> {
  const folder = await folderOf(account, folderName, false);
  if (!folder) return 0;
  let freed = 0;
  for (const f of folder.children?.filter((c) => !c.directory && c.name === filename) ?? []) {
    freed += f.size ?? 0;
    await f.delete(true);
  }
  if (freed > 0) await (await session(account)).reload(true);
  return freed;
}

export function deleteObject(account: MegaAccount, filename: string): Promise<number> {
  return deleteFile(account, OBJECTS_FOLDER, filename);
}
