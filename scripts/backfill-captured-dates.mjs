// One-off backfill: for every manifest entry uploaded before capture-date
// extraction existed (no `captured_ts` field), download + decrypt the
// object, read its embedded EXIF/QuickTime date, and patch the manifest.
// Everything happens locally -- the passphrase is read from a hidden
// terminal prompt (never a CLI arg / env var), same guarantee as
// scripts/upload-iphone-pics.mjs.
//
// Run with: node scripts/backfill-captured-dates.mjs
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
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
const VAULT_FOLDER_NAME = "vault";
const RESULTS_PATH = path.resolve(process.env.HOME, "vault-backfill-results.txt");
const PERSIST_EVERY = 10; // save manifest progress every N patched entries

// ---------------------------------------------------------------------------
// pCloud REST helpers (mirrors lib/pcloudServer.ts / upload-iphone-pics.mjs)
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

async function ensureVaultFolder(token) {
  const listing = await pcloudGet("listfolder", { access_token: token, folderid: "0" });
  const existing = (listing.metadata?.contents ?? []).find((e) => e.isfolder && e.name === VAULT_FOLDER_NAME);
  if (existing) return existing.folderid;
  throw new Error("vault folder not found on this account");
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

async function getFileidInFolder(token, folderid, filename) {
  const listing = await pcloudGet("listfolder", { access_token: token, folderid: String(folderid) });
  const found = (listing.metadata?.contents ?? []).find((e) => !e.isfolder && e.name === filename);
  return found ? found.fileid : null;
}

async function getFileLink(token, fileid) {
  const json = await pcloudGet("getfilelink", { access_token: token, fileid: String(fileid) });
  const host = json.hosts[0];
  return `https://${host}${json.path}`;
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
async function unwrapFileKey(wrapKey, fileIdHex, wrapNonceHex, wrappedKeyHex) {
  const fileId = hexToBytes(fileIdHex);
  const nonce = hexToBytes(wrapNonceHex);
  const wrapped = hexToBytes(wrappedKeyHex);
  return aesGcmDecrypt(wrapKey, nonce, wrapped, fileId);
}
async function decryptPvltObject(buf, fileKey, fileIdHex) {
  const fileId = hexToBytes(fileIdHex);
  let off = 0;
  const magic = buf.subarray(off, off + 4); off += 4;
  if (!concatBytes(magic).every((b, i) => b === MAGIC[i])) throw new Error("not a vault file (bad magic)");
  const version = buf[off]; off += 1;
  if (version !== 1) throw new Error(`unsupported vault file format version ${version}`);
  const headerNonce = buf.subarray(off, off + NONCE_LEN); off += NONCE_LEN;
  const headerLen = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, false); off += 4;
  const headerCt = buf.subarray(off, off + headerLen); off += headerLen;

  const headerPlain = await aesGcmDecrypt(fileKey, headerNonce, headerCt, fileId);
  const metadata = JSON.parse(new TextDecoder().decode(headerPlain));

  const chunks = [];
  for (let idx = 0; idx < metadata.num_chunks; idx++) {
    const nonce = buf.subarray(off, off + NONCE_LEN); off += NONCE_LEN;
    const maxCtLen = metadata.chunk_size + TAG_LEN;
    const remaining = buf.length - off;
    const ctLen = Math.min(maxCtLen, remaining);
    const ct = buf.subarray(off, off + ctLen); off += ctLen;
    chunks.push(await aesGcmDecrypt(fileKey, nonce, ct, chunkAad(fileId, idx)));
  }
  return { metadata, plaintext: concatBytes(...chunks) };
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------
function promptHidden(query) {
  return new Promise((resolve) => {
    process.stdout.write(query);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let input = "";
    const onData = (char) => {
      if (char === "\n" || char === "\r" || char === "") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
      } else if (char === "") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "" || char === "\b") {
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
  const accountByName = new Map(accounts.map((a) => [a.name, a]));

  writeFileSync(RESULTS_PATH, `Capture-date backfill run started ${new Date().toISOString()}\n\n`);

  console.log("Fetching vault config + manifest from pCloud...");
  const folderid = await ensureVaultFolder(primary.token);

  const configFileid = await getFileidInFolder(primary.token, folderid, "vault.config.json");
  const configLink = await getFileLink(primary.token, configFileid);
  const configJson = await (await fetch(configLink)).json();

  const manifestFileid = await getFileidInFolder(primary.token, folderid, "manifest.enc");
  const manifestLink = await getFileLink(primary.token, manifestFileid);
  let manifestBuf = new Uint8Array(await (await fetch(manifestLink)).arrayBuffer());

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

  const allEntries = Object.values(manifest.entries);
  const targets = allEntries.filter((e) => e.captured_ts === undefined);
  log(`Manifest has ${allEntries.length} entries; ${targets.length} missing captured_ts.`);

  let patched = 0;
  let noDate = 0;
  let failed = 0;
  let sinceLastSave = 0;

  for (const entry of targets) {
    const accountName = entry.extra?.pcloud_account;
    const account = accountByName.get(accountName) ?? primary;
    try {
      const objFolderid = account.name === primary.name ? folderid : await ensureVaultFolder(account.token);
      const objFileid = await getFileidInFolder(account.token, objFolderid, `${entry.file_id_hex}.pvlt`);
      if (objFileid === null) {
        failed++;
        log(`FAIL (object not found): ${entry.filename}`);
        continue;
      }
      const link = await getFileLink(account.token, objFileid);
      const buf = new Uint8Array(await (await fetch(link)).arrayBuffer());

      const fileKey = await unwrapFileKey(wrapKey, entry.file_id_hex, entry.wrap_nonce_hex, entry.wrapped_key_hex);
      const { plaintext } = await decryptPvltObject(buf, fileKey, entry.file_id_hex);

      const capturedTs = await extractCapturedTs(plaintext);
      if (capturedTs === null) {
        noDate++;
        log(`NO DATE (no EXIF/QuickTime date found): ${entry.filename}`);
        continue;
      }

      manifest.entries[entry.file_id_hex] = { ...entry, captured_ts: capturedTs };
      patched++;
      sinceLastSave++;
      log(`OK: ${entry.filename} -> captured_ts=${new Date(capturedTs * 1000).toISOString()}`);

      if (sinceLastSave >= PERSIST_EVERY) {
        manifest = { ...manifest, updated_ts: Date.now() / 1000 };
        const manifestBlob = await encryptManifest(headerKey, manifest);
        await uploadCiphertext(primary.token, folderid, "manifest.enc", manifestBlob);
        sinceLastSave = 0;
        log(`  (progress saved: ${patched} patched so far)`);
      }
    } catch (e) {
      failed++;
      log(`FAIL: ${entry.filename} -- ${e.message}`);
    }
  }

  if (sinceLastSave > 0) {
    manifest = { ...manifest, updated_ts: Date.now() / 1000 };
    const manifestBlob = await encryptManifest(headerKey, manifest);
    await uploadCiphertext(primary.token, folderid, "manifest.enc", manifestBlob);
  }

  log("\n=== SUMMARY ===");
  log(`Patched with a real captured_ts: ${patched}`);
  log(`No EXIF/QuickTime date found (left on added_ts fallback): ${noDate}`);
  log(`Failed: ${failed}`);
  log(`\nResults file: ${RESULTS_PATH}`);
}

main().catch((e) => {
  console.error("BACKFILL RUN FAILED:", e);
  process.exit(1);
});
