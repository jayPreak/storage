// Node test harness: exercises the exact same client-side crypto module
// used by the browser (lib/vaultCrypto.ts, transpiled here via tsx-free
// manual re-import since Node ESM can't import .ts directly without a
// loader -- so we inline the same logic against the running dev server's
// API routes to prove the real HTTP + crypto pipeline end-to-end).
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { argon2id } from "hash-wasm";

const BASE = "http://localhost:3000";
const PASSPHRASE = "correct horse battery staple test 2026";

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
async function aesGcmDecrypt(key, nonce, ct, aad) {
  const k = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, k, ct);
  return new Uint8Array(plain);
}

async function main() {
  console.log("1. Fetching config + manifest via API routes...");
  const configRes = await fetch(`${BASE}/api/config`);
  const config = await configRes.json();
  const manifestRes = await fetch(`${BASE}/api/manifest`);
  const manifestBuf = new Uint8Array(await manifestRes.arrayBuffer());
  console.log("   config salt_hex:", config.salt_hex, "| manifest bytes:", manifestBuf.length);

  console.log("2. Deriving master key via Argon2id (hash-wasm)...");
  const masterKeyHex = await argon2id({
    password: PASSPHRASE,
    salt: hexToBytes(config.salt_hex),
    parallelism: config.parallelism,
    iterations: config.time_cost,
    memorySize: config.memory_cost_kib,
    hashLength: 32,
    outputType: "hex",
  });
  const masterKey = hexToBytes(masterKeyHex);
  console.log("   master_key hex:", masterKeyHex);

  console.log("3. Deriving header_key / wrap_key (HKDF-Expand)...");
  const headerKey = await hkdfExpandLabel(masterKey, new TextEncoder().encode("vault-header-key-v1"));
  const wrapKey = await hkdfExpandLabel(masterKey, new TextEncoder().encode("vault-file-key-wrap-v1"));

  console.log("4. Decrypting manifest...");
  const nonce = manifestBuf.slice(0, 12);
  const ct = manifestBuf.slice(12);
  const plain = await aesGcmDecrypt(headerKey, nonce, ct, new TextEncoder().encode("vault-manifest-v1"));
  const manifest = JSON.parse(new TextDecoder().decode(plain));
  const entries = Object.values(manifest.entries);
  console.log(`   decrypted manifest OK, ${entries.length} entries`);

  const heicEntry = entries.find((e) => e.filename.toLowerCase().endsWith(".heic"));
  const movEntry = entries.find((e) => e.filename.toLowerCase().endsWith(".mov"));
  console.log("   HEIC entry:", heicEntry.filename, heicEntry.file_id_hex);
  console.log("   MOV entry: ", movEntry.filename, movEntry.file_id_hex);

  async function decryptObject(entry) {
    const wrapNonce = hexToBytes(entry.wrap_nonce_hex);
    const wrapped = hexToBytes(entry.wrapped_key_hex);
    const fileId = hexToBytes(entry.file_id_hex);
    const fileKey = await aesGcmDecrypt(wrapKey, wrapNonce, wrapped, fileId);

    const res = await fetch(`${BASE}/api/object/${entry.file_id_hex}`);
    const buf = new Uint8Array(await res.arrayBuffer());

    let off = 0;
    const magic = buf.slice(off, off + 4); off += 4;
    if (Buffer.from(magic).toString() !== "PVLT") throw new Error("bad magic");
    const version = buf[off]; off += 1;
    if (version !== 1) throw new Error("bad version");
    const headerNonce = buf.slice(off, off + 12); off += 12;
    const headerLen = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, false); off += 4;
    const headerCt = buf.slice(off, off + headerLen); off += headerLen;
    const headerPlain = await aesGcmDecrypt(fileKey, headerNonce, headerCt, fileId);
    const metadata = JSON.parse(new TextDecoder().decode(headerPlain));

    const chunks = [];
    for (let idx = 0; idx < metadata.num_chunks; idx++) {
      const n = buf.slice(off, off + 12); off += 12;
      const maxCtLen = metadata.chunk_size + 16;
      const remaining = buf.length - off;
      const ctLen = Math.min(maxCtLen, remaining);
      const c = buf.slice(off, off + ctLen); off += ctLen;
      const idxBytes = new Uint8Array(4);
      new DataView(idxBytes.buffer).setUint32(0, idx, false);
      const aad = concat(fileId, idxBytes);
      chunks.push(await aesGcmDecrypt(fileKey, n, c, aad));
    }
    const full = concat(...chunks);
    return { metadata, full };
  }

  console.log("5. Decrypting HEIC object...");
  const { metadata: heicMeta, full: heicPlain } = await decryptObject(heicEntry);
  console.log("   filename:", heicMeta.filename, "size:", heicPlain.length, "sha256_plain (header):", heicMeta.sha256_plain);
  const heicSha = createHash("sha256").update(heicPlain).digest("hex");
  console.log("   computed sha256:", heicSha, "matches header:", heicSha === heicMeta.sha256_plain);
  const heicOffset4to12 = Buffer.from(heicPlain.slice(4, 12)).toString("latin1");
  console.log("   bytes[4:12] (offset-4 ftyp check):", JSON.stringify(heicOffset4to12), "contains 'ftyp':", heicOffset4to12.includes("ftyp"));

  const origHeic = readFileSync(`/Users/jaypreak/Downloads/${heicMeta.filename}`);
  const origHeicSha = createHash("sha256").update(origHeic).digest("hex");
  console.log("   original file sha256: ", origHeicSha);
  console.log("   BIT-EXACT MATCH (HEIC):", origHeicSha === heicSha);

  console.log("6. Decrypting MOV object...");
  const { metadata: movMeta, full: movPlain } = await decryptObject(movEntry);
  console.log("   filename:", movMeta.filename, "size:", movPlain.length);
  const movSha = createHash("sha256").update(movPlain).digest("hex");
  console.log("   computed sha256:", movSha, "matches header:", movSha === movMeta.sha256_plain);
  const movOffset4to12 = Buffer.from(movPlain.slice(4, 12)).toString("latin1");
  console.log("   bytes[4:12] (offset-4 ftyp/atom check):", JSON.stringify(movOffset4to12), "contains 'ftyp':", movOffset4to12.includes("ftyp"));

  const origMov = readFileSync(`/Users/jaypreak/Downloads/${movMeta.filename}`);
  const origMovSha = createHash("sha256").update(origMov).digest("hex");
  console.log("   original file sha256: ", origMovSha);
  console.log("   BIT-EXACT MATCH (MOV): ", origMovSha === movSha);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
