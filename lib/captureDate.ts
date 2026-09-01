// Best-effort capture-date extraction from EXIF (photos) / QuickTime
// metadata (videos), run client-side on plaintext bytes before encryption
// so the original file's embedded date never leaves the browser in any
// other form. Never throws -- a missing/unparseable date just falls back
// to upload time at the call site.
import exifr from "exifr";

export async function extractCapturedTs(plaintext: Uint8Array): Promise<number | null> {
  try {
    const tags = await exifr.parse(plaintext, {
      pick: ["DateTimeOriginal", "CreateDate"],
    });
    const date: Date | undefined = tags?.DateTimeOriginal ?? tags?.CreateDate;
    if (!date || Number.isNaN(date.getTime())) return null;
    return date.getTime() / 1000;
  } catch {
    return null;
  }
}
