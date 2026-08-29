// One-time migration: uploads the bundled local demo vault (manifest.enc +
// objects/*.pvlt) to the primary pCloud account's vault folder. Standalone
// script -- run with `node scripts/migrate-local-to-pcloud.mjs` from
// webapp/, reads PCLOUD_ACCOUNTS from .env.local manually since this isn't
// a Next.js request context. Reuses the same plain-fetch calls as
// lib/pcloudServer.ts (inlined here so this can run outside Next).
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnvLocal();

const API_BASE = "https://eapi.pcloud.com/";
const VAULT_DIR = path.resolve(process.cwd(), "vault-data");
const OBJECTS_DIR = path.join(VAULT_DIR, "objects");
const MANIFEST_PATH = path.join(VAULT_DIR, "manifest.enc");
const CONFIG_PATH = path.join(VAULT_DIR, "vault.config.json");

async function pcloudGet(method, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${method}?${qs}`);
  const json = await res.json();
  if (json.result !== 0) {
    throw new Error(`pCloud ${method} failed: result=${json.result} error=${json.error ?? "unknown"}`);
  }
  return json;
}

async function ensureVaultFolder(token) {
  const listing = await pcloudGet("listfolder", { access_token: token, folderid: "0" });
  const existing = (listing.metadata?.contents ?? []).find((e) => e.isfolder && e.name === "vault");
  if (existing) return existing.folderid;
  try {
    const created = await pcloudGet("createfolder", {
      access_token: token, folderid: "0", name: "vault", excludefromsync: "0",
    });
    return created.metadata.folderid;
  } catch {
    const relisting = await pcloudGet("listfolder", { access_token: token, folderid: "0" });
    const found = (relisting.metadata?.contents ?? []).find((e) => e.isfolder && e.name === "vault");
    if (found) return found.folderid;
    throw new Error("could not create or find vault folder");
  }
}

async function uploadCiphertext(token, folderid, filename, buffer) {
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  const qs = new URLSearchParams({
    access_token: token, folderid: String(folderid), filename, renameifexists: "0",
  }).toString();
  const res = await fetch(`${API_BASE}uploadfile?${qs}`, { method: "POST", body: form });
  const json = await res.json();
  if (json.result !== 0) throw new Error(`upload failed for ${filename}: result=${json.result}`);
  return json.metadata[0].fileid;
}

async function listFolder(token, folderid) {
  const listing = await pcloudGet("listfolder", { access_token: token, folderid: String(folderid) });
  return listing.metadata?.contents ?? [];
}

async function main() {
  const accounts = JSON.parse(process.env.PCLOUD_ACCOUNTS);
  const primary = accounts[0];
  console.log(`Using primary account: ${primary.name}`);

  const folderid = await ensureVaultFolder(primary.token);
  console.log(`vault folder id: ${folderid}`);

  const objectFiles = (await readdir(OBJECTS_DIR)).filter((f) => f.endsWith(".pvlt"));
  console.log(`Uploading ${objectFiles.length} objects...`);
  let uploaded = 0;
  for (const filename of objectFiles) {
    const buf = await readFile(path.join(OBJECTS_DIR, filename));
    await uploadCiphertext(primary.token, folderid, filename, buf);
    uploaded++;
    console.log(`  [${uploaded}/${objectFiles.length}] ${filename} (${buf.length} bytes)`);
  }

  console.log("Uploading manifest.enc...");
  const manifestBuf = await readFile(MANIFEST_PATH);
  await uploadCiphertext(primary.token, folderid, "manifest.enc", manifestBuf);

  console.log("Uploading vault.config.json...");
  const configBuf = await readFile(CONFIG_PATH);
  await uploadCiphertext(primary.token, folderid, "vault.config.json", configBuf);

  console.log("Verifying via listfolder...");
  const contents = await listFolder(primary.token, folderid);
  const pvltCount = contents.filter((e) => !e.isfolder && e.name.endsWith(".pvlt")).length;
  const hasManifest = contents.some((e) => !e.isfolder && e.name === "manifest.enc");
  const hasConfig = contents.some((e) => !e.isfolder && e.name === "vault.config.json");

  console.log(`\nSummary: ${uploaded} objects uploaded, manifest ${hasManifest ? "present" : "MISSING"}, config ${hasConfig ? "present" : "MISSING"}.`);
  console.log(`pCloud vault folder now contains ${pvltCount} .pvlt files (expected ${objectFiles.length}).`);
}

main().catch((e) => { console.error("MIGRATION FAILED:", e); process.exit(1); });
