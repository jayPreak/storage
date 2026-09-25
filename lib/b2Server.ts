// Server-only Backblaze B2 client (native API v2). NEVER import this from a
// client component -- it reads B2_ACCOUNTS (application keys) from
// process.env. Mirrors pcloudServer.ts: accounts are a JSON array so adding
// another B2 account is an env var change only.
//
// Unlike pCloud, B2 can't tell us "how much of my self-imposed cap have I
// used", so per-account usage lives in the B2 section of
// storage-summary.json (see lib/storageServer.ts) and quotaBytes here is
// operator-supplied.
import { createHash } from "node:crypto";

const AUTH_URL = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";
// B2 auth tokens are valid for 24h; refresh a bit early.
const AUTH_TTL_MS = 23 * 60 * 60 * 1000;

// Object layout inside each account's bucket, matching the pCloud folders.
export const OBJECTS_PREFIX = "vault/";
export const THUMBS_PREFIX = "vault-thumbs/";

export interface B2Account {
  name: string;
  keyId: string;
  applicationKey: string;
  bucketId: string;
  bucketName: string;
  quotaBytes: number;
}

interface B2Auth {
  token: string;
  apiUrl: string;
  downloadUrl: string;
  expiresAt: number;
}

export function loadAccounts(): B2Account[] {
  const raw = process.env.B2_ACCOUNTS;
  if (!raw) return []; // B2 is optional; pCloud alone is a valid config
  const parsed = JSON.parse(raw) as B2Account[];
  if (!Array.isArray(parsed)) {
    throw new Error("B2_ACCOUNTS must be a JSON array");
  }
  return parsed;
}

export function accountByName(name: string): B2Account | undefined {
  return loadAccounts().find((a) => a.name === name);
}

// Module scope survives across warm invocations of the same function
// instance; a cold start just re-authorizes.
const authCache = new Map<string, B2Auth>();

async function authorize(account: B2Account, force = false): Promise<B2Auth> {
  const cached = authCache.get(account.name);
  if (!force && cached && cached.expiresAt > Date.now()) return cached;

  const basic = Buffer.from(`${account.keyId}:${account.applicationKey}`).toString("base64");
  const res = await fetch(AUTH_URL, { headers: { Authorization: `Basic ${basic}` } });
  if (!res.ok) {
    throw new Error(`B2 authorize failed for ${account.name}: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { authorizationToken: string; apiUrl: string; downloadUrl: string };
  const auth = {
    token: json.authorizationToken,
    apiUrl: json.apiUrl,
    downloadUrl: json.downloadUrl,
    expiresAt: Date.now() + AUTH_TTL_MS,
  };
  authCache.set(account.name, auth);
  return auth;
}

// Runs `fn` with a cached auth, re-authorizing once if B2 answers 401
// (token expired/revoked before our TTL guessed it would).
async function withAuth(account: B2Account, fn: (auth: B2Auth) => Promise<Response>): Promise<Response> {
  const res = await fn(await authorize(account));
  if (res.status !== 401) return res;
  return fn(await authorize(account, true));
}

async function b2Api<T>(account: B2Account, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await withAuth(account, (auth) =>
    fetch(`${auth.apiUrl}/b2api/v2/${method}`, {
      method: "POST",
      headers: { Authorization: auth.token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { code?: string } | null;
    throw new Error(`B2 ${method} failed for ${account.name}: HTTP ${res.status} ${err?.code ?? ""}`.trim());
  }
  return (await res.json()) as T;
}

function encodeFileName(fileName: string): string {
  return fileName.split("/").map(encodeURIComponent).join("/");
}

async function uploadOnce(account: B2Account, fileName: string, bytes: Uint8Array, sha1: string): Promise<Response> {
  const { uploadUrl, authorizationToken } = await b2Api<{ uploadUrl: string; authorizationToken: string }>(
    account,
    "b2_get_upload_url",
    { bucketId: account.bucketId }
  );
  return fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: authorizationToken,
      "X-Bz-File-Name": encodeFileName(fileName),
      "Content-Type": "b2/x-auto",
      "Content-Length": String(bytes.length),
      "X-Bz-Content-Sha1": sha1,
    },
    body: bytes as BodyInit,
  });
}

export async function uploadFile(account: B2Account, fileName: string, bytes: Uint8Array): Promise<void> {
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  let res = await uploadOnce(account, fileName, bytes, sha1);
  // Upload URLs can go stale/busy (401/503); B2's guidance is to fetch a
  // fresh one and retry.
  if (res.status === 401 || res.status === 503) {
    res = await uploadOnce(account, fileName, bytes, sha1);
  }
  if (!res.ok) {
    throw new Error(`B2 upload failed for ${fileName} on ${account.name}: HTTP ${res.status}`);
  }
}

export function uploadCiphertext(account: B2Account, filename: string, buffer: Buffer): Promise<void> {
  return uploadFile(account, `${OBJECTS_PREFIX}${filename}`, buffer);
}

// Returns null on 404 so callers can map it to their own "not found".
export async function downloadFile(account: B2Account, fileName: string): Promise<Response | null> {
  const res = await withAuth(account, (auth) =>
    fetch(`${auth.downloadUrl}/file/${encodeURIComponent(account.bucketName)}/${encodeFileName(fileName)}`, {
      headers: { Authorization: auth.token },
    })
  );
  if (res.status === 404) return null;
  if (!res.ok || !res.body) {
    throw new Error(`B2 download failed for ${fileName} on ${account.name}: HTTP ${res.status}`);
  }
  return res;
}

export async function fetchObjectCiphertext(account: B2Account, filename: string): Promise<Buffer | null> {
  const res = await downloadFile(account, `${OBJECTS_PREFIX}${filename}`);
  return res ? Buffer.from(await res.arrayBuffer()) : null;
}

// Deletes every stored version of `fileName` (re-uploading a name, e.g. a
// regenerated thumbnail, leaves the old version behind and still billed).
// Returns the total bytes freed so the usage ledger can be decremented.
export async function deleteFile(account: B2Account, fileName: string): Promise<number> {
  const listing = await b2Api<{ files: { fileName: string; fileId: string; contentLength: number }[] }>(
    account,
    "b2_list_file_versions",
    { bucketId: account.bucketId, startFileName: fileName, prefix: fileName, maxFileCount: 100 }
  );
  let freed = 0;
  for (const f of listing.files) {
    if (f.fileName !== fileName) continue;
    await b2Api(account, "b2_delete_file_version", { fileName: f.fileName, fileId: f.fileId });
    freed += f.contentLength;
  }
  return freed;
}

export function deleteObject(account: B2Account, filename: string): Promise<number> {
  return deleteFile(account, `${OBJECTS_PREFIX}${filename}`);
}
