// Transient preview-only transcode. The browser sends only the per-file
// key it already unwrapped (small JSON body -- well under Vercel's ~4.5MB
// serverless request-body cap, unlike sending the whole decrypted video
// used to). This route fetches the ciphertext itself (like /api/object),
// decrypts it in memory with that one file key, runs it through ffmpeg to
// produce H.264/AAC that all browsers can play, streams the result back,
// then deletes the temp files. Nothing is persisted, and this route never
// has the wrap key, the master key, or the passphrase -- only ever a
// single unwrapped file key for the one object it's asked to transcode.
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import { decryptPvltObject, fetchObjectCiphertext } from "@/lib/pvltServer";

export const runtime = "nodejs";
export const maxDuration = 60;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

// Re-encode is the slow path (tens of seconds for phone-shot 4K footage), so
// cap resolution and use the fastest x264 preset that still gets reasonable
// compression -- this is a disposable in-browser preview, not the download.
const TRANSCODE_ARGS = (inPath: string, outPath: string) => [
  "-y",
  "-i", inPath,
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "23",
  "-vf", "scale='min(1920,iw)':-2",
  "-c:a", "aac",
  "-movflags", "+faststart",
  outPath,
];

// ffmpeg dumps stream info to stderr even when given no output at all; this
// is much cheaper than a real transcode and lets us skip re-encoding
// entirely when the source is already browser-playable (just muxed into a
// .mov container instead of .mp4).
async function probeStreamCodecs(inPath: string): Promise<{ video: string | null; audio: string | null }> {
  const stderr = await new Promise<string>((resolve) => {
    const proc = spawn(ffmpegPath as string, ["-y", "-i", inPath, "-hide_banner", "-f", "null", "-t", "0", "-"]);
    let out = "";
    proc.stderr.on("data", (d) => { out += d.toString(); });
    proc.on("close", () => resolve(out));
    proc.on("error", () => resolve(out));
  });
  const videoMatch = stderr.match(/Stream #\d+:\d+.*?: Video: (\w+)/);
  const audioMatch = stderr.match(/Stream #\d+:\d+.*?: Audio: (\w+)/);
  return {
    video: videoMatch ? videoMatch[1].toLowerCase() : null,
    audio: audioMatch ? audioMatch[1].toLowerCase() : null,
  };
}

export async function POST(req: Request) {
  if (!ffmpegPath) {
    return NextResponse.json({ error: "ffmpeg binary not available" }, { status: 500 });
  }

  let body: { file_id_hex?: string; file_key_hex?: string; account?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { file_id_hex, file_key_hex, account } = body;

  if (!file_id_hex || !isValidFileIdHex(file_id_hex)) {
    return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  }
  if (!file_key_hex || !/^[0-9a-f]{64}$/i.test(file_key_hex)) {
    return NextResponse.json({ error: "invalid file key" }, { status: 400 });
  }

  const dir = await mkdtemp(path.join(tmpdir(), "vault-transcode-"));
  const inPath = path.join(dir, "in");
  const outPath = path.join(dir, "out.mp4");

  try {
    const ciphertext = await fetchObjectCiphertext(file_id_hex, account);
    const fileKey = Buffer.from(file_key_hex, "hex");
    const { plaintext } = decryptPvltObject(ciphertext, fileKey, file_id_hex);

    await writeFile(inPath, plaintext);

    const probe = await probeStreamCodecs(inPath);
    const alreadyPlayable =
      (probe.video === null || probe.video === "h264") &&
      (probe.audio === null || ["aac", "mp3"].includes(probe.audio));

    if (alreadyPlayable) {
      // Same codecs, just the wrong container -- remux only (no re-encode,
      // ~1s instead of tens of seconds).
      try {
        await runFfmpeg(["-y", "-i", inPath, "-c", "copy", "-movflags", "+faststart", outPath]);
      } catch {
        // Fall back to a real re-encode if the remux-only path rejects this
        // particular file for some reason (e.g. an edge-case container quirk).
        await runFfmpeg(TRANSCODE_ARGS(inPath, outPath));
      }
    } else {
      await runFfmpeg(TRANSCODE_ARGS(inPath, outPath));
    }

    const mp4 = await readFile(outPath);
    return new NextResponse(mp4 as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": "video/mp4" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
