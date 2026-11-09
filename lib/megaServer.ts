// Server-only, READ-ONLY MEGA client (via `megajs`) that reads through a
// MEGA public *folder link* -- the webapp never logs in to MEGA.
//
// Why: MEGA flags accounts that log in from many IPs in a short time, and
// every serverless instance logging in separately looks exactly like that
// (that is how the first account got blocked). A folder link needs no
// login, so there is nothing to flag. Everything in the folder is opaque
// ciphertext already encrypted client-side, so the link alone reveals no
// photo content, but treat it as a secret anyway (MEGA_ACCOUNTS is a
// server-only env var).
//
// Writes (uploads, deletes, quota checks) are NOT done here. They need a
// login, so they happen from the owner's machine through rclone / the vault
// scripts. Create the link once with `rclone link <remote>:vault` (see
// scripts/add-mega-account.mjs).
//
// MEGA_ACCOUNTS is a JSON array: [{ "name": "mega", "folderLink": "https://mega.nz/folder/ID#KEY" }]
import { File } from "megajs";

export interface MegaAccount {
  name: string;
  folderLink: string; // public link to the account's `vault` folder
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

// One cached folder listing per account, shared by concurrent requests on a
// warm instance. A listing is a single API call for the whole folder.
const LISTING_TTL_MS = 10 * 60 * 1000;
// Don't re-list more often than this even on repeated misses, so a burst of
// requests for missing files can't hammer MEGA.
const MIN_RELIST_MS = 30 * 1000;

interface Listing {
  loadedAt: number;
  byName: Map<string, File>;
}
const listings = new Map<string, Promise<Listing>>();

function loadListing(account: MegaAccount): Promise<Listing> {
  const p = (async () => {
    const folder = File.fromURL(account.folderLink);
    await folder.loadAttributes();
    const byName = new Map<string, File>();
    for (const child of folder.children ?? []) {
      if (!child.directory && child.name) byName.set(child.name, child);
    }
    return { loadedAt: Date.now(), byName };
  })();
  listings.set(account.name, p);
  // A failed listing must not be cached.
  p.catch(() => {
    if (listings.get(account.name) === p) listings.delete(account.name);
  });
  return p;
}

async function listing(account: MegaAccount, forceFresh = false): Promise<Listing> {
  const cached = listings.get(account.name);
  const l = cached ? await cached.catch(() => null) : null;
  if (l) {
    const age = Date.now() - l.loadedAt;
    if (!forceFresh && age < LISTING_TTL_MS) return l;
    if (forceFresh && age < MIN_RELIST_MS) return l; // refreshed too recently
  }
  return loadListing(account);
}

// Returns null when the file doesn't exist so callers can map it to 404.
export async function fetchObjectCiphertext(account: MegaAccount, filename: string): Promise<Buffer | null> {
  let l = await listing(account);
  let file = l.byName.get(filename);
  if (!file) {
    // Maybe uploaded since our snapshot; refresh once (rate-limited).
    l = await listing(account, true);
    file = l.byName.get(filename);
    if (!file) return null;
  }
  return file.downloadBuffer({});
}
