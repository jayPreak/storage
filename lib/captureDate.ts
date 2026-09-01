// Best-effort capture-date extraction from EXIF (photos, incl. HEIC) /
// QuickTime metadata (.mov, .mp4), run client-side on plaintext bytes
// before encryption so the original file's embedded date never leaves the
// browser in any other form. Never throws -- a missing/unparseable date
// just falls back to upload time at the call site.
import exifr from "exifr";

// Seconds between the QuickTime/Mac "creation_time" epoch (1904-01-01) and
// the Unix epoch (1970-01-01).
const QT_EPOCH_OFFSET = 2082844800;

// exifr only handles photo formats (JPEG/TIFF/PNG/HEIC) -- it has no
// MOV/MP4 support. Both containers are ISO-BMFF/QuickTime boxes, so read
// the `moov` box's `mvhd` sub-box directly for its creation_time field.
// https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap2/qtff2.html
function extractQuickTimeCapturedTs(buf: Uint8Array): number | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  function findBox(start: number, end: number, name: string): [number, number] | null {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      let headerLen = 8;
      if (size === 1) {
        // 64-bit extended size, stored as the next 8 bytes.
        if (offset + 16 > end) return null;
        const bigSize = view.getBigUint64(offset + 8);
        size = Number(bigSize);
        headerLen = 16;
      } else if (size === 0) {
        // Box extends to the end of the file (only legal for the last box).
        size = end - offset;
      }
      const type = String.fromCharCode(
        buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7]
      );
      if (type === name) return [offset + headerLen, offset + size];
      if (size < headerLen || offset + size > end) return null;
      offset += size;
    }
    return null;
  }

  const moov = findBox(0, buf.length, "moov");
  if (!moov) return null;
  const mvhd = findBox(moov[0], moov[1], "mvhd");
  if (!mvhd) return null;

  const [mvhdStart] = mvhd;
  const version = buf[mvhdStart];
  // version(1) + flags(3) precede creation_time.
  const creationTime =
    version === 1 ? Number(view.getBigUint64(mvhdStart + 4)) : view.getUint32(mvhdStart + 4);
  if (!creationTime) return null;

  const unixTs = creationTime - QT_EPOCH_OFFSET;
  if (unixTs <= 0) return null; // sentinel/unset creation_time
  return unixTs;
}

export async function extractCapturedTs(plaintext: Uint8Array): Promise<number | null> {
  const qtTs = extractQuickTimeCapturedTs(plaintext);
  if (qtTs !== null) return qtTs;

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
