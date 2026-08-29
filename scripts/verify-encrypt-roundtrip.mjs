// Standalone Node harness that exercises the new encrypt-side functions
// against the existing decrypt-side functions in lib/vaultCrypto.ts, proving
// byte-for-byte round trips without touching the dev server or pCloud.
// Node ESM can't import .ts directly, so this inlines the same logic (same
// pattern as scripts/verify-full-pipeline.mjs).
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b) {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
function randomBytes(n) {
  return new Uint8Array(nodeRandomBytes(n));
}
async function aesGcmEncrypt(key, nonce, plain, aad) {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, k, plain);
  return new Uint8Array(ct);
}
async function aesGcmDecrypt(key, nonce, ct, aad) {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, k, ct);
  return new Uint8Array(plain);
}
function chunkAad(fileId, idx) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, idx, false);
  return concat(fileId, b);
}

const MAGIC = new TextEncoder().encode("PVLT");
const NONCE_LEN = 12;
const TAG_LEN = 16;
const CHUNK_SIZE = 64; // small on purpose, forces multiple chunks in the test

async function encryptPvltObject(plaintext, fileKey, fileIdHex, meta) {
  const fileId = hexToBytes(fileIdHex);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext));
  const sha256_plain = bytesToHex(digest);
  const chunks = [];
  let numChunks = 0;
  if (plaintext.length === 0) {
    const nonce = randomBytes(NONCE_LEN);
    const ct = await aesGcmEncrypt(fileKey, nonce, new Uint8Array(0), chunkAad(fileId, 0));
    chunks.push(concat(nonce, ct));
    numChunks = 1;
  } else {
    for (let off = 0; off < plaintext.length; off += CHUNK_SIZE) {
      const plain = plaintext.slice(off, off + CHUNK_SIZE);
      const nonce = randomBytes(NONCE_LEN);
      const ct = await aesGcmEncrypt(fileKey, nonce, plain, chunkAad(fileId, numChunks));
      chunks.push(concat(nonce, ct));
      numChunks++;
    }
  }
  const metadata = {
    filename: meta.filename, mime_type: meta.mime_type, size: plaintext.length,
    created_ts: meta.created_ts, chunk_size: CHUNK_SIZE, num_chunks: numChunks,
    sha256_plain, extra: meta.extra ?? {},
  };
  const headerPlain = new TextEncoder().encode(JSON.stringify(metadata));
  const headerNonce = randomBytes(NONCE_LEN);
  const headerCt = await aesGcmEncrypt(fileKey, headerNonce, headerPlain, fileId);
  const headerLen = new Uint8Array(4);
  new DataView(headerLen.buffer).setUint32(0, headerCt.length, false);
  return concat(MAGIC, Uint8Array.of(1), headerNonce, headerLen, headerCt, ...chunks);
}

async function decryptPvltObject(buf, fileKey, fileIdHex) {
  const fileId = hexToBytes(fileIdHex);
  let off = 0;
  const magic = buf.slice(off, off + 4); off += 4;
  if (Buffer.from(magic).toString() !== "PVLT") throw new Error("bad magic");
  const version = buf[off]; off += 1;
  if (version !== 1) throw new Error("bad version");
  const headerNonce = buf.slice(off, off + NONCE_LEN); off += NONCE_LEN;
  const headerLen = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, false); off += 4;
  const headerCt = buf.slice(off, off + headerLen); off += headerLen;
  const headerPlain = await aesGcmDecrypt(fileKey, headerNonce, headerCt, fileId);
  const metadata = JSON.parse(new TextDecoder().decode(headerPlain));
  const chunks = [];
  for (let idx = 0; idx < metadata.num_chunks; idx++) {
    const nonce = buf.slice(off, off + NONCE_LEN); off += NONCE_LEN;
    const maxCtLen = metadata.chunk_size + TAG_LEN;
    const remaining = buf.length - off;
    const ctLen = Math.min(maxCtLen, remaining);
    const ct = buf.slice(off, off + ctLen); off += ctLen;
    const plain = await aesGcmDecrypt(fileKey, nonce, ct, chunkAad(fileId, idx));
    chunks.push(plain);
  }
  return { metadata, plaintext: concat(...chunks) };
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
    t = await hmacSha256(masterKey, concat(t, label, Uint8Array.of(counter)));
    out = concat(out, t);
    counter++;
  }
  return out.slice(0, length);
}
async function wrapFileKey(wrapKey, fileIdHex, fileKey) {
  const nonce = randomBytes(NONCE_LEN);
  const fileId = hexToBytes(fileIdHex);
  const wrapped = await aesGcmEncrypt(wrapKey, nonce, fileKey, fileId);
  return { wrap_nonce_hex: bytesToHex(nonce), wrapped_key_hex: bytesToHex(wrapped) };
}
async function unwrapFileKey(wrapKey, wrapNonceHex, wrappedKeyHex, fileIdHex) {
  return aesGcmDecrypt(wrapKey, hexToBytes(wrapNonceHex), hexToBytes(wrappedKeyHex), hexToBytes(fileIdHex));
}
const MANIFEST_AAD = new TextEncoder().encode("vault-manifest-v1");
async function encryptManifest(headerKey, manifest) {
  const nonce = randomBytes(12);
  const plain = new TextEncoder().encode(JSON.stringify(manifest));
  const ct = await aesGcmEncrypt(headerKey, nonce, plain, MANIFEST_AAD);
  return concat(nonce, ct);
}
async function decryptManifest(blob, headerKey) {
  const nonce = blob.slice(0, 12);
  const ct = blob.slice(12);
  const plain = await aesGcmDecrypt(headerKey, nonce, ct, MANIFEST_AAD);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function main() {
  const masterKey = randomBytes(32);
  const headerKey = await hkdfExpandLabel(masterKey, new TextEncoder().encode("vault-header-key-v1"));
  const wrapKey = await hkdfExpandLabel(masterKey, new TextEncoder().encode("vault-file-key-wrap-v1"));

  console.log("1. encryptPvltObject -> decryptPvltObject round trip...");
  const fileIdHex = bytesToHex(randomBytes(16));
  const fileKey = randomBytes(32);
  const plaintext = randomBytes(500); // > CHUNK_SIZE(64) so multiple chunks are exercised
  const origSha = createHash("sha256").update(plaintext).digest("hex");

  const encrypted = await encryptPvltObject(plaintext, fileKey, fileIdHex, {
    filename: "test.bin", mime_type: "application/octet-stream", created_ts: Date.now() / 1000,
  });
  const { metadata, plaintext: decrypted } = await decryptPvltObject(encrypted, fileKey, fileIdHex);
  const decSha = createHash("sha256").update(decrypted).digest("hex");
  const ok1 = decSha === origSha && metadata.sha256_plain === origSha && Buffer.from(decrypted).equals(Buffer.from(plaintext));
  console.log("   num_chunks:", metadata.num_chunks, "| bit-exact:", ok1);
  if (!ok1) throw new Error("PVLT object round trip FAILED");

  console.log("2. wrapFileKey -> unwrapFileKey round trip...");
  const { wrap_nonce_hex, wrapped_key_hex } = await wrapFileKey(wrapKey, fileIdHex, fileKey);
  const unwrapped = await unwrapFileKey(wrapKey, wrap_nonce_hex, wrapped_key_hex, fileIdHex);
  const ok2 = Buffer.from(unwrapped).equals(Buffer.from(fileKey));
  console.log("   unwrapped key matches original:", ok2);
  if (!ok2) throw new Error("file key wrap round trip FAILED");

  console.log("3. encryptManifest -> decryptManifest round trip...");
  const manifest = {
    created_ts: Date.now() / 1000,
    updated_ts: Date.now() / 1000,
    entries: {
      [fileIdHex]: {
        file_id_hex: fileIdHex,
        wrap_nonce_hex, wrapped_key_hex,
        object_path: `objects/${fileIdHex}.pvlt`,
        filename: "test.bin", mime_type: "application/octet-stream", size: plaintext.length,
        added_ts: Date.now() / 1000, deleted: false, extra: { pcloud_account: "pcloud1" },
      },
    },
  };
  const manifestBlob = await encryptManifest(headerKey, manifest);
  const decryptedManifest = await decryptManifest(manifestBlob, headerKey);
  const ok3 = JSON.stringify(decryptedManifest) === JSON.stringify(manifest);
  console.log("   manifest round trip matches:", ok3);
  if (!ok3) throw new Error("manifest round trip FAILED");

  console.log("\nALL ROUND TRIPS PASSED");
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
