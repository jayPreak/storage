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
 *
 * The WASM decoder is memory-hungry (a 12MP photo is ~48MB of RGBA plus
 * the WASM heap), so callers should prefer the browser's native decoder
 * first -- Safari on iOS 17+/macOS 14+ decodes HEIC natively -- and only
 * fall back to this. The module is imported lazily so browsers that never
 * need it never download it.
 */
export async function convertHeicToJpeg(plaintext: Uint8Array | Blob): Promise<Blob> {
  const sourceBlob =
    plaintext instanceof Blob
      ? plaintext
      : new Blob([plaintext as BlobPart], { type: "image/heic" });
  const { heicTo } = await import("heic-to/next");
  return heicTo({
    blob: sourceBlob,
    type: "image/jpeg",
    quality: 0.92,
  });
}

/**
 * True if this browser can decode the given image blob by itself (e.g.
 * Safari with HEIC). Uses an <img> decode so a positive result means the
 * same blob can be shown directly via an object URL without converting.
 */
export async function canDecodeNatively(blob: Blob): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img.naturalWidth > 0;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}
