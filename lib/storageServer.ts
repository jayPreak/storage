// Server-only unified storage pool across pCloud and Backblaze B2 accounts.
// Upload placement is one first-fit scan: pCloud accounts (live quota) in
// PCLOUD_ACCOUNTS order, then B2 accounts (ledger-based usage) in
// B2_ACCOUNTS order -- adding an account to either list is config-only.
import * as pcloud from "@/lib/pcloudServer";
import * as b2 from "@/lib/b2Server";
import type { Backend } from "@/lib/storageBackend";

export { resolveBackend } from "@/lib/storageBackend";
export type { Backend, BackendRef } from "@/lib/storageBackend";

export interface StorageAccount {
  backend: Backend;
  name: string;
}

export type ResolvedAccount =
  | { backend: "pcloud"; account: pcloud.PcloudAccount }
  | { backend: "b2"; account: b2.B2Account };

const PCLOUD_SAFETY_MARGIN_BYTES = 50 * 1024 * 1024;
// Bigger than pCloud's: B2 usage is our own ledger, which can drift a bit
// (concurrent read-modify-writes, uploads whose manifest save then failed).
const B2_SAFETY_MARGIN_BYTES = 200 * 1024 * 1024;

const SUMMARY_FILENAME = "storage-summary.json";

// ---- storage-summary.json (unencrypted, primary pCloud vault folder) ----
// `accounts` is written by scripts/upload-iphone-pics.mjs; `b2` is the B2
// usage ledger written here after every B2 upload/delete. Each writer
// preserves the other's section.

export interface B2LedgerEntry {
  usedBytes: number;
  updatedAt: string;
}

export interface StorageSummary {
  updated_ts?: number;
  accounts?: { name: string; backend: string; quota: number | null; usedquota: number | null }[];
  b2?: Record<string, B2LedgerEntry>;
}

export async function readStorageSummary(): Promise<StorageSummary | null> {
  const account = pcloud.primaryAccount();
  const folderid = await pcloud.ensureVaultFolder(account.token);
  const fileid = await pcloud.getFileidInFolder(account.token, folderid, SUMMARY_FILENAME);
  if (fileid === null) return null;
  const link = await pcloud.getFileLink(account.token, fileid);
  const res = await fetch(link);
  if (!res.ok) throw new Error(`failed to read ${SUMMARY_FILENAME}: HTTP ${res.status}`);
  return (await res.json()) as StorageSummary;
}

// Read-modify-write; not atomic, which is accepted (see B2_SAFETY_MARGIN_BYTES).
export async function adjustB2Usage(accountName: string, deltaBytes: number): Promise<void> {
  if (deltaBytes === 0) return;
  const summary = (await readStorageSummary()) ?? {};
  const ledger = summary.b2 ?? {};
  const prev = ledger[accountName]?.usedBytes ?? 0;
  ledger[accountName] = { usedBytes: Math.max(0, prev + deltaBytes), updatedAt: new Date().toISOString() };
  summary.b2 = ledger;

  const account = pcloud.primaryAccount();
  const folderid = await pcloud.ensureVaultFolder(account.token);
  await pcloud.uploadCiphertext(account.token, folderid, SUMMARY_FILENAME, Buffer.from(JSON.stringify(summary)));
}

// Ledger updates must never fail the storage operation itself: the object
// is already written/deleted, and the client still needs to record that.
export async function adjustB2UsageBestEffort(accountName: string, deltaBytes: number): Promise<void> {
  try {
    await adjustB2Usage(accountName, deltaBytes);
  } catch (e) {
    console.error(`B2 usage ledger update failed for ${accountName} (${deltaBytes} bytes):`, e);
  }
}

// ---- Unified picker ----

export async function pickAccountForUpload(fileSizeBytes: number): Promise<StorageAccount> {
  const errors: string[] = [];

  for (const account of pcloud.loadAccounts()) {
    try {
      const { quota, usedquota } = await pcloud.getQuota(account.token);
      if (quota - usedquota >= fileSizeBytes + PCLOUD_SAFETY_MARGIN_BYTES) {
        return { backend: "pcloud", name: account.name };
      }
    } catch (e) {
      errors.push(`pcloud/${account.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const b2Accounts = b2.loadAccounts();
  if (b2Accounts.length > 0) {
    let ledger: Record<string, B2LedgerEntry> | null = null;
    try {
      ledger = (await readStorageSummary())?.b2 ?? {};
    } catch (e) {
      // Without the ledger we can't tell how full B2 is -- refuse rather
      // than guess and blow through the self-imposed cap.
      errors.push(`b2 ledger: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (ledger) {
      for (const account of b2Accounts) {
        const used = ledger[account.name]?.usedBytes ?? 0;
        if (account.quotaBytes - B2_SAFETY_MARGIN_BYTES - used >= fileSizeBytes) {
          return { backend: "b2", name: account.name };
        }
      }
    }
  }

  throw new Error(
    `All configured storage accounts are full (or unreachable) for a ${fileSizeBytes}-byte upload. ` +
      `Add another account to PCLOUD_ACCOUNTS or B2_ACCOUNTS.` +
      (errors.length ? ` Errors: ${errors.join("; ")}` : "")
  );
}

export function resolveAccount(backend: Backend, name: string): ResolvedAccount | null {
  if (backend === "b2") {
    const account = b2.accountByName(name);
    return account ? { backend, account } : null;
  }
  const account = pcloud.accountByName(name);
  return account ? { backend, account } : null;
}

// Parses a ?backend= value, defaulting to pcloud for legacy links that only
// carry ?account=. Returns null for an unknown backend.
export function parseBackendParam(value: string | null | undefined): Backend | null {
  if (value === undefined || value === null || value === "" || value === "pcloud") return "pcloud";
  if (value === "b2") return "b2";
  return null;
}
