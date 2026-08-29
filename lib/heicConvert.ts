/**
 * Client-side HEIC -> JPEG conversion using `heic-to` (WASM libheif build).
 *
 * This runs entirely in the browser: it takes already-decrypted plaintext
 * bytes (a Blob) and decodes/re-encodes them locally. No network round trip
 * is involved, preserving the vault's "plaintext never leaves the browser"
 * guarantee.
 *
 * Some HEIC/HEIF variants (multi-image containers, image sequences, some
 * 10-bit HDR HEIC) may not be supported by the underlying WASM libheif
 * build and will throw -- callers should catch and show a per-file error
 * rather than crashing the page.
 */
import { heicTo } from "heic-to/next";

export async function convertHeicToJpeg(plaintext: Uint8Array): Promise<Blob> {
  const sourceBlob = new Blob([plaintext.buffer as ArrayBuffer], {
    type: "image/heic",
  });
  return heicTo({
    blob: sourceBlob,
    type: "image/jpeg",
    quality: 0.92,
  });
}
