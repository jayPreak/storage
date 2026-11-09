// Server-only, READ-ONLY MEGA client (via `megajs`) that reads through MEGA
// public *folder links* -- the webapp never logs in to MEGA.
//
// Why: MEGA administratively blocks accounts that log in too often / from
// too many places (rclone's docs: rapid successive commands get a remote
// blocked, recovering after ~a week). Every serverless instance logging in
// separately is exactly that pattern, and is how the first account got
// blocked. A folder link needs no login, so there is nothing to block.
//
// Everything in the folders is opaque ciphertext already encrypted
// client-side, so a link alone reveals no photo content, but treat links as
// secrets anyway (MEGA_ACCOUNTS is a server-only env var).
//
// Writes (uploads, deletes) need a login, so they are NOT done here; they
// happen from the owner's machine through rclone / the vault scripts.
//
// MEGA_ACCOUNTS is a JSON array:
//   [{ "name": "mega",
//      "folderLink": "https://mega.nz/folder/ID#KEY",   // the `vault` folder
//      "thumbsLink": "https://mega.nz/folder/ID#KEY",   // optional `vault-thumbs`
//      "quotaBytes": 21474836480 }]                      // optional, for the storage UI
import { File } from "megajs";

export interface MegaAccount {
  name: string;
  folderLink: string;
  thumbsLink?: string;
  quotaBytes?: number;
}

export const DEFAULT_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;

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

// Thrown when MEGA is pushing back (transfer quota, congestion, block). The
// routes turn it into a 503 + Retry-After instead of "object not found", so
// the client retries later rather than treating the file as missing.
export class MegaUnavailableError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, detail: string) {
    super(`MEGA temporarily unavailable: ${detail}`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// ---- Circuit breaker: once MEGA says no, stop asking for a while ----------
const COOLDOWN_MS = 10 * 60 * 1000;
let cooldownUntil = 0;
let cooldownReason = "";

function checkCooldown() {
  if (Date.now() < cooldownUntil) {
    throw new MegaUnavailableError(Math.ceil((cooldownUntil - Date.now()) / 1000), cooldownReason);
  }
}

// megajs errors look like "EOVERQUOTA (-17): ..." / "EAGAIN (-3): ..." /
// "EBLOCKED (-16): ...". Anything that means "slow down" trips the breaker.
function tripIfThrottled(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/EOVERQUOTA|EAGAIN|EBLOCKED|ETOOMANY|ERATELIMIT|\(-(3|16|17|18)\)|quota|509/i.test(msg)) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    cooldownReason = msg.slice(0, 120);
    throw new MegaUnavailableError(COOLDOWN_MS / 1000, cooldownReason);
  }
  throw e;
}

// ---- Concurrency cap: a gallery fires dozens of requests at once ----------
const MAX_CONCURRENT = 3;
let active = 0;
const waiters: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

// ---- Folder listings: one cached listing per link, one API call each ------
const LISTING_TTL_MS = 10 * 60 * 1000;
// Don't re-list more often than this even on repeated misses, so a burst of
// requests for missing files can't hammer MEGA.
const MIN_RELIST_MS = 30 * 1000;

interface Listing {
  loadedAt: number;
  byName: Map<string, File>;
}
const listings = new Map<string, Promise<Listing>>();

function loadListing(link: string): Promise<Listing> {
  const p = (async () => {
    try {
      const folder = File.fromURL(link);
      await folder.loadAttributes();
      const byName = new Map<string, File>();
      for (const child of folder.children ?? []) {
        if (!child.directory && child.name) byName.set(child.name, child);
      }
      return { loadedAt: Date.now(), byName };
    } catch (e) {
      return tripIfThrottled(e);
    }
  })();
  listings.set(link, p);
  p.catch(() => {
    if (listings.get(link) === p) listings.delete(link); // never cache a failure
  });
  return p;
}

async function listing(link: string, forceFresh = false): Promise<Listing> {
  const cached = listings.get(link);
  const l = cached ? await cached.catch(() => null) : null;
  if (l) {
    const age = Date.now() - l.loadedAt;
    if (!forceFresh && age < LISTING_TTL_MS) return l;
    if (forceFresh && age < MIN_RELIST_MS) return l; // refreshed too recently
  }
  checkCooldown();
  return loadListing(link);
}

async function fetchFrom(link: string, filename: string): Promise<Buffer | null> {
  let l = await listing(link);
  let file = l.byName.get(filename);
  if (!file) {
    // Maybe uploaded since our snapshot; refresh once (rate-limited).
    l = await listing(link, true);
    file = l.byName.get(filename);
    if (!file) return null;
  }
  checkCooldown();
  const f = file;
  return limited(async () => {
    try {
      return await f.downloadBuffer({});
    } catch (e) {
      return tripIfThrottled(e);
    }
  });
}

// Returns null when the file doesn't exist so callers can map it to 404.
export function fetchObjectCiphertext(account: MegaAccount, filename: string): Promise<Buffer | null> {
  return fetchFrom(account.folderLink, filename);
}

export async function fetchThumbCiphertext(account: MegaAccount, filename: string): Promise<Buffer | null> {
  if (!account.thumbsLink) return null;
  return fetchFrom(account.thumbsLink, filename);
}

// Used bytes of the `vault` folder, summed from the (cached) listing: no login.
export async function usedBytes(account: MegaAccount): Promise<number> {
  const l = await listing(account.folderLink);
  let total = 0;
  for (const f of l.byName.values()) total += f.size ?? 0;
  return total;
}
