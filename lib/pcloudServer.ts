// Server-only pCloud client. NEVER import this from a client component --
// it reads PCLOUD_ACCOUNTS (bearer-equivalent tokens) from process.env and
// talks to eapi.pcloud.com directly. Stateless by design: every call looks
// up whatever it needs fresh, since Vercel functions have no persistent
// memory/disk across invocations.
const API_BASE = "https://eapi.pcloud.com/";
const VAULT_FOLDER_NAME = "vault";
const SAFETY_MARGIN_BYTES = 50 * 1024 * 1024; // 50MB headroom on top of file size

export interface PcloudAccount {
  name: string;
  token: string;
}

export function loadAccounts(): PcloudAccount[] {
  const raw = process.env.PCLOUD_ACCOUNTS;
  if (!raw) {
    throw new Error("PCLOUD_ACCOUNTS env var is not set");
  }
  const parsed = JSON.parse(raw) as PcloudAccount[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("PCLOUD_ACCOUNTS must be a non-empty JSON array");
  }
  return parsed;
}

export function primaryAccount(): PcloudAccount {
  return loadAccounts()[0];
}

function maskToken(token: string): string {
  return token.length <= 8 ? "***" : `${token.slice(0, 4)}...${token.slice(-4)}`;
}

async function pcloudGet(method: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${method}?${qs}`);
  const json = await res.json();
  if (json.result !== 0) {
    throw new Error(`pCloud ${method} failed: result=${json.result} error=${json.error ?? "unknown"}`);
  }
  return json;
}

export async function getQuota(token: string): Promise<{ quota: number; usedquota: number }> {
  const json = await pcloudGet("userinfo", { access_token: token });
  return { quota: json.quota, usedquota: json.usedquota };
}

export async function ensureVaultFolder(token: string): Promise<number> {
  const listing = await pcloudGet("listfolder", { access_token: token, folderid: "0" });
  const existing = (listing.metadata?.contents ?? []).find(
    (e: any) => e.isfolder && e.name === VAULT_FOLDER_NAME
  );
  if (existing) return existing.folderid;

  try {
    const created = await pcloudGet("createfolder", {
      access_token: token,
      folderid: "0",
      name: VAULT_FOLDER_NAME,
      excludefromsync: "0",
    });
    return created.metadata.folderid;
  } catch (e) {
    // 2004 = folder already exists (race with another invocation); look it up again.
    const relisting = await pcloudGet("listfolder", { access_token: token, folderid: "0" });
    const found = (relisting.metadata?.contents ?? []).find(
      (entry: any) => entry.isfolder && entry.name === VAULT_FOLDER_NAME
    );
    if (found) return found.folderid;
    throw e;
  }
}

export async function uploadCiphertext(
  token: string,
  folderid: number,
  filename: string,
  buffer: Buffer
): Promise<number> {
  const form = new FormData();
  // pCloud ignores the form field name and uses the `filename` query/form
  // param for the stored name -- but we still need to attach a Blob part.
  form.append("file", new Blob([new Uint8Array(buffer)]), filename);

  const qs = new URLSearchParams({
    access_token: token,
    folderid: String(folderid),
    filename,
    renameifexists: "0", // default overwrite behavior per pCloud docs, made explicit
  }).toString();

  const res = await fetch(`${API_BASE}uploadfile?${qs}`, { method: "POST", body: form });
  const json = await res.json();
  if (json.result !== 0) {
    throw new Error(`pCloud uploadfile failed for ${filename}: result=${json.result}`);
  }
  return json.metadata[0].fileid;
}

export async function getFileLink(token: string, fileid: number): Promise<string> {
  const json = await pcloudGet("getfilelink", { access_token: token, fileid: String(fileid) });
  const host = json.hosts[0];
  return `https://${host}${json.path}`;
}

export async function pickAccountForUpload(fileSizeBytes: number): Promise<PcloudAccount> {
  const accounts = loadAccounts();
  const minFree = fileSizeBytes + SAFETY_MARGIN_BYTES;
  const errors: string[] = [];
  for (const account of accounts) {
    try {
      const { quota, usedquota } = await getQuota(account.token);
      if (quota - usedquota >= minFree) {
        return account;
      }
    } catch (e) {
      errors.push(`${account.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(
    `All configured pCloud accounts are full (or unreachable) for a ${fileSizeBytes}-byte upload. ` +
      `Add another account to PCLOUD_ACCOUNTS.` +
      (errors.length ? ` Errors: ${errors.join("; ")}` : "")
  );
}

export async function findAccountHoldingFile(filename: string): Promise<PcloudAccount | null> {
  const accounts = loadAccounts();
  for (const account of accounts) {
    try {
      const folderid = await ensureVaultFolder(account.token);
      const listing = await pcloudGet("listfolder", {
        access_token: account.token,
        folderid: String(folderid),
      });
      const found = (listing.metadata?.contents ?? []).some(
        (e: any) => !e.isfolder && e.name === filename
      );
      if (found) return account;
    } catch {
      // try the next account
    }
  }
  return null;
}

export async function getFileidInFolder(token: string, folderid: number, filename: string): Promise<number | null> {
  const listing = await pcloudGet("listfolder", { access_token: token, folderid: String(folderid) });
  const found = (listing.metadata?.contents ?? []).find((e: any) => !e.isfolder && e.name === filename);
  return found ? found.fileid : null;
}

export function accountByName(name: string): PcloudAccount | undefined {
  return loadAccounts().find((a) => a.name === name);
}

export { maskToken };
