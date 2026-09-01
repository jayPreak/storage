// Bulk-import Downloads/iphone pics into the pCloud vault, alphabetically,
// using the exact same crypto pipeline as the browser app (lib/vaultCrypto.ts)
// and the same pCloud upload path as app/api/upload + app/api/manifest.
// Run with: node scripts/upload-iphone-pics.mjs
//
// The passphrase is read from a hidden terminal prompt (never passed as a
// CLI arg or env var, never printed, never sent anywhere but into the local
// Argon2id derivation) -- matching the app's "passphrase never leaves this
// device" guarantee.
import { readFile, readdir, stat } from "node:fs/promises";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

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
const VAULT_FOLDER_NAME = "vault";
const SAFETY_MARGIN_BYTES = 50 * 1024 * 1024;
const WATCH_DIR = path.join(os.homedir(), "Downloads", "iphone pics");
const WATCHED_EXTENSIONS = new Set([".mov", ".heic", ".jpg", ".jpeg", ".png", ".mp4"]);
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const RESULTS_PATH = path.resolve(
  process.env.HOME,
  "vault-upload-results.txt"
);
const UPLOADED_FILENAMES_PATH = path.resolve(
  process.env.HOME,
  "vault-uploaded-filenames.txt"
);

// ---------------------------------------------------------------------------
// pCloud REST helpers (mirrors lib/pcloudServer.ts)
// ---------------------------------------------------------------------------
async function pcloudGet(method, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${method}?${qs}`);
  const json = await res.json();
  if (json.result !== 0) {
    throw new Error(`pCloud ${method} failed: result=${json.result} error=${json.error ?? "unknown"}`);
  }
  return json;
}

async function getQuota(token) {
  const json = await pcloudGet("userinfo", { access_token: token });
  return { quota: json.quota, usedquota: json.usedquota };
}

async function ensureVaultFolder(token) {
  const listing = await pcloudGet("listfolder", { access_token: token, folderid: "0" });
  const existing = (listing.metadata?.contents ?? []).find((e) => e.isfolder && e.name === VAULT_FOLDER_NAME);
  if (existing) return existing.folderid;
  try {
    const created = await pcloudGet("createfolder", {
      access_token: token, folderid: "0", name: VAULT_FOLDER_NAME, excludefromsync: "0",
    });
    return created.metadata.folderid;
  } catch {
    const relisting = await pcloudGet("listfolder", { access_token: token, folderid: "0" });
    const found = (relisting.metadata?.contents ?? []).find((e) => e.isfolder && e.name === VAULT_FOLDER_NAME);
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

async function getFileidInFolder(token, folderid, filename) {
  const contents = await listFolder(token, folderid);
  const found = contents.find((e) => !e.isfolder && e.name === filename);
  return found ? found.fileid : null;
}

async function getFileLink(token, fileid) {
  const json = await pcloudGet("getfilelink", { access_token: token, fileid: String(fileid) });
  const host = json.hosts[0];
  return `https://${host}${json.path}`;
}

async function pickAccountForUpload(accounts, fileSizeBytes) {
  const minFree = fileSizeBytes + SAFETY_MARGIN_BYTES;
  const errors = [];
  for (const account of accounts) {
    try {
      const { quota, usedquota } = await getQuota(account.token);
      if (quota - usedquota >= minFree) return account;
    } catch (e) {
      errors.push(`${account.name}: ${e.message}`);
    }
  }
  throw new Error(`all pCloud accounts full/unreachable for a ${fileSizeBytes}-byte upload` + (errors.length ? `; ${errors.join("; ")}` : ""));
}

// ---------------------------------------------------------------------------
// Crypto (mirrors lib/vaultCrypto.ts, byte-for-byte)
// ---------------------------------------------------------------------------
import { argon2id } from "hash-wasm";
import exifr from "exifr";

async function extractCapturedTs(plaintext) {
  try {
    const tags = await exifr.parse(plaintext, { pick: ["DateTimeOriginal", "CreateDate"] });
    const date = tags?.DateTimeOriginal ?? tags?.CreateDate;
    if (!date || Number.isNaN(date.getTime())) return null;
    return date.getTime() / 1000;
  } catch {
    return null;
  }
}

function hexToBytes(hex) {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
async function hkdfExpandLabel(masterKey, label, length = 32) {
  let out = new Uint8Array(0);
  let t = new Uint8Array(0);
  let counter = 1;
  while (out.length < length) {
    t = await hmacSha256(masterKey, concatBytes(t, label, Uint8Array.of(counter)));
    out = concatBytes(out, t);
    counter++;
  }
  return out.slice(0, length);
}
async function aesGcmEncrypt(key, nonce, plaintext, aad) {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, k, plaintext);
  return new Uint8Array(ct);
}
async function aesGcmDecrypt(key, nonce, ciphertextWithTag, aad) {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, k, ciphertextWithTag);
  return new Uint8Array(plain);
}
function randomBytes(len) {
  const out = new Uint8Array(len);
  crypto.getRandomValues(out);
  return out;
}

const HEADER_KEY_LABEL = new TextEncoder().encode("vault-header-key-v1");
const WRAP_KEY_LABEL = new TextEncoder().encode("vault-file-key-wrap-v1");
const MANIFEST_AAD = new TextEncoder().encode("vault-manifest-v1");
const MAGIC = new TextEncoder().encode("PVLT");
const NONCE_LEN = 12;
const TAG_LEN = 16;

function chunkAad(fileId, chunkIndex) {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, chunkIndex, false);
  return concatBytes(fileId, idx);
}

async function deriveSubkeys(masterKey) {
  const headerKey = await hkdfExpandLabel(masterKey, HEADER_KEY_LABEL);
  const wrapKey = await hkdfExpandLabel(masterKey, WRAP_KEY_LABEL);
  return { headerKey, wrapKey };
}

async function decryptManifest(blob, headerKey) {
  const nonce = blob.slice(0, 12);
  const ct = blob.slice(12);
  const plain = await aesGcmDecrypt(headerKey, nonce, ct, MANIFEST_AAD);
  return JSON.parse(new TextDecoder().decode(plain));
}
async function encryptManifest(headerKey, manifest) {
  const nonce = randomBytes(12);
  const plain = new TextEncoder().encode(JSON.stringify(manifest));
  const ct = await aesGcmEncrypt(headerKey, nonce, plain, MANIFEST_AAD);
  return Buffer.from(concatBytes(nonce, ct));
}
async function wrapFileKey(wrapKey, fileIdHex, fileKey) {
  const nonce = randomBytes(12);
  const fileId = hexToBytes(fileIdHex);
  const wrapped = await aesGcmEncrypt(wrapKey, nonce, fileKey, fileId);
  return { wrap_nonce_hex: bytesToHex(nonce), wrapped_key_hex: bytesToHex(wrapped) };
}
async function encryptPvltObject(plaintext, fileKey, fileIdHex, metadataIn) {
  const fileId = hexToBytes(fileIdHex);
  const chunkSize = metadataIn.chunk_size ?? DEFAULT_CHUNK_SIZE;
  const digest = await crypto.subtle.digest("SHA-256", plaintext);
  const sha256Plain = bytesToHex(new Uint8Array(digest));

  const chunks = [];
  let numChunks = 0;
  if (plaintext.length === 0) {
    const nonce = randomBytes(NONCE_LEN);
    const ct = await aesGcmEncrypt(fileKey, nonce, new Uint8Array(0), chunkAad(fileId, 0));
    chunks.push(concatBytes(nonce, ct));
    numChunks = 1;
  } else {
    for (let off = 0; off < plaintext.length; off += chunkSize) {
      const plain = plaintext.slice(off, off + chunkSize);
      const nonce = randomBytes(NONCE_LEN);
      const ct = await aesGcmEncrypt(fileKey, nonce, plain, chunkAad(fileId, numChunks));
      chunks.push(concatBytes(nonce, ct));
      numChunks++;
    }
  }

  const metadata = {
    filename: metadataIn.filename,
    mime_type: metadataIn.mime_type,
    size: plaintext.length,
    created_ts: metadataIn.created_ts,
    chunk_size: chunkSize,
    num_chunks: numChunks,
    sha256_plain: sha256Plain,
    extra: metadataIn.extra ?? {},
  };
  const headerPlain = new TextEncoder().encode(JSON.stringify(metadata));
  const headerNonce = randomBytes(NONCE_LEN);
  const headerCt = await aesGcmEncrypt(fileKey, headerNonce, headerPlain, fileId);
  const headerLen = new Uint8Array(4);
  new DataView(headerLen.buffer).setUint32(0, headerCt.length, false);

  return Buffer.from(concatBytes(MAGIC, Uint8Array.of(1), headerNonce, headerLen, headerCt, ...chunks));
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------
function mimeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".heic": return "image/heic";
    case ".mov": return "video/quicktime";
    case ".mp4": return "video/mp4";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    default: return "application/octet-stream";
  }
}

function promptHidden(query) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let input = "";
    const onData = (char) => {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "\u007f" || char === "\b") {
        input = input.slice(0, -1);
      } else {
        input += char;
      }
    };
    stdin.on("data", onData);
  });
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(RESULTS_PATH, stamped + "\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const accounts = JSON.parse(process.env.PCLOUD_ACCOUNTS);
  const primary = accounts[0];

  writeFileSync(
    RESULTS_PATH,
    `Vault upload run started ${new Date().toISOString()}\nSource: ${WATCH_DIR}\nAccounts: ${accounts.map((a) => a.name).join(", ")}\n\n`
  );

  console.log("Fetching vault config + manifest from pCloud...");
  const folderid = await ensureVaultFolder(primary.token);

  let configJson;
  const configFileid = await getFileidInFolder(primary.token, folderid, "vault.config.json");
  if (configFileid !== null) {
    const link = await getFileLink(primary.token, configFileid);
    configJson = await (await fetch(link)).json();
  } else {
    configJson = JSON.parse(readFileSync(path.resolve(process.cwd(), "vault-data/vault.config.json"), "utf8"));
    await uploadCiphertext(primary.token, folderid, "vault.config.json", Buffer.from(JSON.stringify(configJson)));
    console.log("  (config wasn't on pCloud yet -- uploaded local copy)");
  }

  let manifestBuf;
  const manifestFileid = await getFileidInFolder(primary.token, folderid, "manifest.enc");
  if (manifestFileid !== null) {
    const link = await getFileLink(primary.token, manifestFileid);
    manifestBuf = new Uint8Array(await (await fetch(link)).arrayBuffer());
  } else {
    manifestBuf = new Uint8Array(readFileSync(path.resolve(process.cwd(), "vault-data/manifest.enc")));
  }

  const passphrase = await promptHidden("Vault passphrase: ");

  console.log("Deriving keys (Argon2id -- this takes a few seconds)...");
  const masterKeyHex = await argon2id({
    password: passphrase,
    salt: hexToBytes(configJson.salt_hex),
    parallelism: configJson.parallelism,
    iterations: configJson.time_cost,
    memorySize: configJson.memory_cost_kib,
    hashLength: 32,
    outputType: "hex",
  });
  const masterKey = hexToBytes(masterKeyHex);
  const { headerKey, wrapKey } = await deriveSubkeys(masterKey);

  let manifest;
  try {
    manifest = await decryptManifest(manifestBuf, headerKey);
  } catch {
    console.error("Failed to decrypt manifest -- wrong passphrase, or corrupted manifest. Aborting.");
    process.exit(1);
  }
  console.log(`Manifest OK. ${Object.keys(manifest.entries).length} existing entries.`);

  const existingFilenames = new Set(Object.values(manifest.entries).map((e) => e.filename));

  const dirents = await readdir(WATCH_DIR, { withFileTypes: true });
  const candidates = dirents
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => WATCHED_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  log(`Found ${candidates.length} candidate files in ${WATCH_DIR}. Starting alphabetical upload.`);

  const uploaded = [];
  const skipped = [];
  const failed = [];
  let stoppedForQuota = false;

  for (const filename of candidates) {
    if (existingFilenames.has(filename)) {
      skipped.push(filename);
      log(`SKIP (already in manifest): ${filename}`);
      continue;
    }

    const fullPath = path.join(WATCH_DIR, filename);
    let size;
    try {
      size = (await stat(fullPath)).size;
    } catch (e) {
      failed.push(filename);
      log(`FAIL (stat): ${filename} -- ${e.message}`);
      continue;
    }
    if (size === 0) {
      skipped.push(filename);
      log(`SKIP (0 bytes): ${filename}`);
      continue;
    }

    let account;
    try {
      account = await pickAccountForUpload(accounts, size);
    } catch (e) {
      log(`STOP: no account has room for ${filename} (${size} bytes) -- ${e.message}`);
      stoppedForQuota = true;
      break;
    }

    try {
      const plaintext = new Uint8Array(await readFile(fullPath));

      const fileIdBytes = randomBytes(16);
      const fileIdHex = bytesToHex(fileIdBytes);
      const fileKey = randomBytes(32);
      const mimeType = mimeFor(filename);
      const capturedTs = await extractCapturedTs(plaintext);

      const encrypted = await encryptPvltObject(plaintext, fileKey, fileIdHex, {
        filename,
        mime_type: mimeType,
        created_ts: Date.now() / 1000,
      });

      const { wrap_nonce_hex, wrapped_key_hex } = await wrapFileKey(wrapKey, fileIdHex, fileKey);

      const accFolderid = account.name === primary.name ? folderid : await ensureVaultFolder(account.token);
      await uploadCiphertext(account.token, accFolderid, `${fileIdHex}.pvlt`, encrypted);

      manifest = {
        ...manifest,
        updated_ts: Date.now() / 1000,
        entries: {
          ...manifest.entries,
          [fileIdHex]: {
            file_id_hex: fileIdHex,
            wrap_nonce_hex,
            wrapped_key_hex,
            object_path: `objects/${fileIdHex}.pvlt`,
            filename,
            mime_type: mimeType,
            size: plaintext.length,
            added_ts: Date.now() / 1000,
            ...(capturedTs !== null ? { captured_ts: capturedTs } : {}),
            deleted: false,
            extra: { pcloud_account: account.name },
          },
        },
      };
      const manifestBlob = await encryptManifest(headerKey, manifest);
      await uploadCiphertext(primary.token, folderid, "manifest.enc", manifestBlob);

      uploaded.push({ filename, size, account: account.name, fileIdHex });
      log(`OK: ${filename} (${size} bytes) -> ${account.name} as ${fileIdHex}.pvlt`);
      appendFileSync(UPLOADED_FILENAMES_PATH, filename + "\n");
    } catch (e) {
      failed.push(filename);
      log(`FAIL: ${filename} -- ${e.message}`);
    }
  }

  log("\n--- Verifying against pCloud + manifest ---");
  const verifyManifestFileid = await getFileidInFolder(primary.token, folderid, "manifest.enc");
  const verifyLink = await getFileLink(primary.token, verifyManifestFileid);
  const verifyManifestBuf = new Uint8Array(await (await fetch(verifyLink)).arrayBuffer());
  const verifyManifest = await decryptManifest(verifyManifestBuf, headerKey);

  let verifiedCount = 0;
  for (const u of uploaded) {
    const entry = verifyManifest.entries[u.fileIdHex];
    if (entry && entry.filename === u.filename) {
      verifiedCount++;
    } else {
      log(`VERIFY MISMATCH: ${u.filename} (${u.fileIdHex}) not found correctly in re-fetched manifest`);
    }
  }
  log(`Verified ${verifiedCount}/${uploaded.length} uploaded entries present in the re-fetched pCloud manifest (this is exactly what the webapp UI reads on unlock).`);

  log("\n=== SUMMARY ===");
  log(`Uploaded: ${uploaded.length}`);
  log(`Skipped (already present / empty): ${skipped.length}`);
  log(`Failed: ${failed.length}`);
  if (stoppedForQuota) log(`Stopped early: all configured pCloud accounts are full.`);
  log(`\nFull uploaded list:`);
  for (const u of uploaded) log(`  ${u.filename} (${u.size} bytes) -> ${u.account}`);
  if (failed.length) {
    log(`\nFailed files:`);
    for (const f of failed) log(`  ${f}`);
  }
  log(`\nResults file: ${RESULTS_PATH}`);
}

main().catch((e) => {
  console.error("UPLOAD RUN FAILED:", e);
  process.exit(1);
});
