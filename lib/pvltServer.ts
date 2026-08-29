// Server-side (Node crypto) port of the .pvlt container decrypt, used ONLY
// by the transcode route. Mirrors lib/vaultCrypto.ts decryptPvltObject()
// exactly (same container layout, same chunk AAD scheme) but takes a
// single per-file key that the browser already unwrapped -- this route
// never has the wrap key, the master key, or the passphrase.
import { createDecipheriv } from "node:crypto";
import {
  accountByName,
  ensureVaultFolder,
  findAccountHoldingFile,
  getFileidInFolder,
  getFileLink,
} from "@/lib/pcloudServer";

const MAGIC = Buffer.from("PVLT");
const NONCE_LEN = 12;
const TAG_LEN = 16;

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

function aesGcmDecrypt(key: Buffer, nonce: Buffer, ciphertextWithTag: Buffer, aad: Buffer): Buffer {
  const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - TAG_LEN);
  const ct = ciphertextWithTag.subarray(0, ciphertextWithTag.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  decipher.setAAD(aad);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function chunkAad(fileId: Buffer, chunkIndex: number): Buffer {
  const idx = Buffer.alloc(4);
  idx.writeUInt32BE(chunkIndex, 0);
  return Buffer.concat([fileId, idx]);
}

export function decryptPvltObject(
  buf: Buffer,
  fileKey: Buffer,
  fileIdHex: string
): { metadata: FileMetadata; plaintext: Buffer } {
  const fileId = Buffer.from(fileIdHex, "hex");

  let off = 0;
  const magic = buf.subarray(off, off + 4);
  off += 4;
  if (!magic.equals(MAGIC)) throw new Error("not a vault file (bad magic)");
  const version = buf[off];
  off += 1;
  if (version !== 1) throw new Error(`unsupported vault file format version ${version}`);
  const headerNonce = buf.subarray(off, off + NONCE_LEN);
  off += NONCE_LEN;
  const headerLen = buf.readUInt32BE(off);
  off += 4;
  const headerCt = buf.subarray(off, off + headerLen);
  off += headerLen;

  const headerPlain = aesGcmDecrypt(fileKey, headerNonce, headerCt, fileId);
  const metadata: FileMetadata = JSON.parse(headerPlain.toString("utf8"));

  const chunks: Buffer[] = [];
  for (let idx = 0; idx < metadata.num_chunks; idx++) {
    const nonce = buf.subarray(off, off + NONCE_LEN);
    off += NONCE_LEN;
    const maxCtLen = metadata.chunk_size + TAG_LEN;
    const remaining = buf.length - off;
    const ctLen = Math.min(maxCtLen, remaining);
    const ct = buf.subarray(off, off + ctLen);
    off += ctLen;
    chunks.push(aesGcmDecrypt(fileKey, nonce, ct, chunkAad(fileId, idx)));
  }

  return { metadata, plaintext: Buffer.concat(chunks) };
}

export async function fetchObjectCiphertext(fileIdHex: string, accountName?: string): Promise<Buffer> {
  const filename = `${fileIdHex}.pvlt`;
  const account = accountName ? accountByName(accountName) : await findAccountHoldingFile(filename);
  if (!account) throw new Error("object not found");

  const folderid = await ensureVaultFolder(account.token);
  const fileid = await getFileidInFolder(account.token, folderid, filename);
  if (fileid === null) throw new Error("object not found");

  const link = await getFileLink(account.token, fileid);
  const upstream = await fetch(link);
  if (!upstream.ok) throw new Error("object not found");
  return Buffer.from(await upstream.arrayBuffer());
}
