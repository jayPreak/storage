// Transient preview-only transcode: receives plaintext video bytes that the
// browser has ALREADY decrypted client-side (this endpoint never sees
// ciphertext or any vault key), runs them through ffmpeg to produce an
// H.264/AAC mp4 that all browsers can play, streams the result back, then
// deletes the temp files. Nothing is persisted -- the original encrypted
// object on pCloud is untouched; this only serves the in-browser <video>
// preview for codecs (e.g. HEVC) that most browsers can't decode.
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!ffmpegPath) {
    return NextResponse.json({ error: "ffmpeg binary not available" }, { status: 500 });
  }

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) {
    return NextResponse.json({ error: "empty body" }, { status: 400 });
  }

  const dir = await mkdtemp(path.join(tmpdir(), "vault-transcode-"));
  const inPath = path.join(dir, "in");
  const outPath = path.join(dir, "out.mp4");

  try {
    await writeFile(inPath, buf);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath as string, [
        "-y",
        "-i", inPath,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-movflags", "+faststart",
        outPath,
      ]);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      });
    });

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
