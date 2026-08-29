/**
 * Client-side re-implementation of the Python vault's crypto pipeline.
 * Every function here is a faithful port of the corresponding function in
 * /Users/jaypreak/Repos/storage/vault/vault/{crypto_backend,keys,manifest,fileformat}.py
 *
 * Nothing in this file ever sends the passphrase or any derived key over
 * the network -- it only runs in the browser (or Node, for the test
 * harness), operating on ciphertext bytes fetched from the API routes.
 */
import { argon2id } from "hash-wasm";

export const ARGON2_TIME_COST = 3;
export const ARGON2_MEMORY_COST_KIB = 256 * 1024; // 262144 KiB
export const ARGON2_PARALLELISM = 4;
export const MASTER_KEY_LEN = 32;

export interface VaultConfig {
  version: number;
  kdf_backend: string;
  aes_backend: string;
  salt_hex: string;
  time_cost: number;
  memory_cost_kib: number;
  parallelism: number;
  verifier_hex: string;
  // seal_* fields intentionally ignored -- unlock-free ingestion feature,
  // not used by this viewer.
}

export interface ManifestEntry {
  file_id_hex: string;
  wrap_nonce_hex: string;
  wrapped_key_hex: string;
  object_path: string;
  filename: string;
  mime_type: string;
  size: number;
  added_ts: number;
  deleted: boolean;
  extra?: Record<string, unknown>;
}

export interface Manifest {
  created_ts: number;
  updated_ts: number;
  entries: Record<string, ManifestEntry>;
}

export interface FileMetadata {
  filename: string;
  mime_type: string;
  size: number;
  created_ts: number;
  chunk_size: number;
  num_chunks: number;
  sha256_plain: string;
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// hex <-> bytes helpers
// ---------------------------------------------------------------------------
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Argon2id: passphrase + salt -> master_key (32B)
// Mirrors vault/crypto_backend.py derive_key() using argon2-cffi Type.ID.
// hash-wasm's argon2id() with parallelism/iterations/memorySize(KiB)/
// hashLength matches argon2-cffi byte-for-byte for the same inputs
// (verified empirically -- see scripts/verify-argon2.mjs).
// ---------------------------------------------------------------------------
export async function deriveMasterKey(
  passphrase: string,
  saltHex: string,
  timeCost: number,
  memoryCostKib: number,
  parallelism: number
): Promise<Uint8Array> {
  const salt = hexToBytes(saltHex);
  const hex = await argon2id({
    password: passphrase,
    salt,
    parallelism,
    iterations: timeCost,
    memorySize: memoryCostKib,
    hashLength: MASTER_KEY_LEN,
    outputType: "hex",
  });
  return hexToBytes(hex);
}

// ---------------------------------------------------------------------------
// HKDF-Expand-only (RFC 5869 Expand step, PRK = master_key directly, no
// Extract step -- mirrors keys.py _hkdf_expand_label exactly). Uses
// WebCrypto HMAC-SHA256 (NOT crypto.subtle.deriveBits("HKDF", ...), which
// performs a full Extract+Expand with a salt and does not match this
// vault's scheme).
// ---------------------------------------------------------------------------
async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoImpl = getCrypto();
  const cryptoKey = await cryptoImpl.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await cryptoImpl.subtle.sign("HMAC", cryptoKey, data as BufferSource);
  return new Uint8Array(sig);
}

async function hkdfExpandLabel(
  masterKey: Uint8Array,
  label: Uint8Array,
  length = 32
): Promise<Uint8Array> {
  let out: Uint8Array = new Uint8Array(0);
  let t: Uint8Array = new Uint8Array(0);
  let counter = 1;
  while (out.length < length) {
    const input = concatBytes(t, label, Uint8Array.of(counter));
    t = await hmacSha256(masterKey, input);
    out = concatBytes(out, t);
    counter++;
  }
  return out.slice(0, length);
}

const HEADER_KEY_LABEL = new TextEncoder().encode("vault-header-key-v1");
const WRAP_KEY_LABEL = new TextEncoder().encode("vault-file-key-wrap-v1");

export async function deriveSubkeys(
  masterKey: Uint8Array
): Promise<{ headerKey: Uint8Array; wrapKey: Uint8Array }> {
  const headerKey = await hkdfExpandLabel(masterKey, HEADER_KEY_LABEL);
  const wrapKey = await hkdfExpandLabel(masterKey, WRAP_KEY_LABEL);
  return { headerKey, wrapKey };
}

// ---------------------------------------------------------------------------
// AES-256-GCM via WebCrypto (or Node's `crypto.webcrypto` in the test
// harness). AAD support via additionalData.
// ---------------------------------------------------------------------------
function getCrypto(): Crypto {
  // In the browser, `crypto` is global. In the Node test harness, we
  // polyfill globalThis.crypto with require("node:crypto").webcrypto
  // before calling into this module.
  return (globalThis as unknown as { crypto: Crypto }).crypto;
}

export async function aesGcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const cryptoImpl = getCrypto();
  const cryptoKey = await cryptoImpl.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const ct = await cryptoImpl.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    cryptoKey,
    plaintext as BufferSource
  );
  return new Uint8Array(ct);
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  getCrypto().getRandomValues(out);
  return out;
}

export async function aesGcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextWithTag: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const cryptoImpl = getCrypto();
  const cryptoKey = await cryptoImpl.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"]
  );
  const plain = await cryptoImpl.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    cryptoKey,
    ciphertextWithTag as BufferSource
  );
  return new Uint8Array(plain);
}

// ---------------------------------------------------------------------------
// Manifest decryption: nonce(12B) || AESGCM(header_key, nonce, json, aad)
// Mirrors manifest.py decrypt_manifest().
// ---------------------------------------------------------------------------
const MANIFEST_AAD = new TextEncoder().encode("vault-manifest-v1");

export async function decryptManifest(
  blob: Uint8Array,
  headerKey: Uint8Array
): Promise<Manifest> {
  const nonce = blob.slice(0, 12);
  const ct = blob.slice(12);
  const plain = await aesGcmDecrypt(headerKey, nonce, ct, MANIFEST_AAD);
  const json = new TextDecoder().decode(plain);
  return JSON.parse(json) as Manifest;
}

// Mirrors manifest.py encrypt_manifest(): nonce(12B) || AESGCM(header_key, nonce, json, aad).
export async function encryptManifest(
  headerKey: Uint8Array,
  manifest: Manifest
): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  const plain = new TextEncoder().encode(JSON.stringify(manifest));
  const ct = await aesGcmEncrypt(headerKey, nonce, plain, MANIFEST_AAD);
  return concatBytes(nonce, ct);
}

// ---------------------------------------------------------------------------
// Per-file key unwrap: AES-256-GCM(wrap_key, wrap_nonce, wrapped_key, aad=file_id)
// Mirrors keys.py unwrap_file_key().
// ---------------------------------------------------------------------------
export async function unwrapFileKey(
  wrapKey: Uint8Array,
  wrapNonceHex: string,
  wrappedKeyHex: string,
  fileIdHex: string
): Promise<Uint8Array> {
  const nonce = hexToBytes(wrapNonceHex);
  const wrapped = hexToBytes(wrappedKeyHex);
  const fileId = hexToBytes(fileIdHex);
  return aesGcmDecrypt(wrapKey, nonce, wrapped, fileId);
}

// Mirrors keys.py wrap_file_key(): AES-256-GCM(wrap_key, nonce, file_key, aad=file_id).
export async function wrapFileKey(
  wrapKey: Uint8Array,
  fileIdHex: string,
  fileKey: Uint8Array
): Promise<{ wrap_nonce_hex: string; wrapped_key_hex: string }> {
  const nonce = randomBytes(12);
  const fileId = hexToBytes(fileIdHex);
  const wrapped = await aesGcmEncrypt(wrapKey, nonce, fileKey, fileId);
  return {
    wrap_nonce_hex: bytesToHex(nonce),
    wrapped_key_hex: bytesToHex(wrapped),
  };
}

// ---------------------------------------------------------------------------
// .pvlt container decryption. Mirrors fileformat.py decrypt_file() /
// read_header(): magic(4B) "PVLT" | version(1B) | header_nonce(12B) |
// header_len(4B BE) | encrypted_header | chunks: nonce(12B)||ct||tag(16B),
// AAD per chunk = file_id_bytes + big-endian uint32 chunk index.
// ---------------------------------------------------------------------------
const MAGIC = new TextEncoder().encode("PVLT");
const NONCE_LEN = 12;
const TAG_LEN = 16;
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024; // mirrors fileformat.py DEFAULT_CHUNK_SIZE

function chunkAad(fileId: Uint8Array, chunkIndex: number): Uint8Array {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, chunkIndex, false); // big-endian
  return concatBytes(fileId, idx);
}

export async function decryptPvltObject(
  buf: Uint8Array,
  fileKey: Uint8Array,
  fileIdHex: string
): Promise<{ metadata: FileMetadata; plaintext: Uint8Array }> {
  const fileId = hexToBytes(fileIdHex);

  let off = 0;
  const magic = buf.slice(off, off + 4);
  off += 4;
  if (bytesToHex(magic) !== bytesToHex(MAGIC)) {
    throw new Error("not a vault file (bad magic)");
  }
  const version = buf[off];
  off += 1;
  if (version !== 1) {
    throw new Error(`unsupported vault file format version ${version}`);
  }
  const headerNonce = buf.slice(off, off + NONCE_LEN);
  off += NONCE_LEN;
  const headerLen = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, false);
  off += 4;
  const headerCt = buf.slice(off, off + headerLen);
  off += headerLen;

  const headerPlain = await aesGcmDecrypt(fileKey, headerNonce, headerCt, fileId);
  const metadata: FileMetadata = JSON.parse(new TextDecoder().decode(headerPlain));

  const chunks: Uint8Array[] = [];
  for (let idx = 0; idx < metadata.num_chunks; idx++) {
    const nonce = buf.slice(off, off + NONCE_LEN);
    off += NONCE_LEN;
    const maxCtLen = metadata.chunk_size + TAG_LEN;
    const remaining = buf.length - off;
    const ctLen = Math.min(maxCtLen, remaining);
    const ct = buf.slice(off, off + ctLen);
    off += ctLen;
    const plain = await aesGcmDecrypt(fileKey, nonce, ct, chunkAad(fileId, idx));
    chunks.push(plain);
  }

  const plaintext = concatBytes(...chunks);
  return { metadata, plaintext };
}

// Mirrors fileformat.py encrypt_file(): same container layout as decryptPvltObject
// expects, chunked AES-256-GCM under file_key with per-chunk AAD = file_id + BE uint32 index.
export async function encryptPvltObject(
  plaintext: Uint8Array,
  fileKey: Uint8Array,
  fileIdHex: string,
  metadataIn: {
    filename: string;
    mime_type: string;
    created_ts: number;
    chunk_size?: number;
    extra?: Record<string, unknown>;
  }
): Promise<Uint8Array> {
  const fileId = hexToBytes(fileIdHex);
  const chunkSize = metadataIn.chunk_size ?? DEFAULT_CHUNK_SIZE;

  const digest = await getCrypto().subtle.digest("SHA-256", plaintext as BufferSource);
  const sha256Plain = bytesToHex(new Uint8Array(digest));

  const chunks: Uint8Array[] = [];
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

  const metadata: FileMetadata = {
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

  return concatBytes(MAGIC, Uint8Array.of(1), headerNonce, headerLen, headerCt, ...chunks);
}
