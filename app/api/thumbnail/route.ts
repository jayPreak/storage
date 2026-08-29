// Server-side thumbnail generation. Like /api/transcode, the browser sends
// only the small per-file key it already unwrapped; this route fetches +
// decrypts the ciphertext itself and hands the plaintext to ffmpeg, which
// extracts a small JPEG (a resized frame for photos/HEIC, a poster frame
// for video) and returns just that -- a few KB instead of the multi-MB
// original. Nothing is persisted. Only ever sees one file's key at a time.
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import { decryptPvltObject, fetchObjectCiphertext } from "@/lib/pvltServer";

export const runtime = "nodejs";
export const maxDuration = 30;

const THUMB_SIZE = 240;

export async function POST(req: Request) {
  if (!ffmpegPath) {
    return NextResponse.json({ error: "ffmpeg binary not available" }, { status: 500 });
  }

  let body: { file_id_hex?: string; file_key_hex?: string; account?: string; is_video?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { file_id_hex, file_key_hex, account, is_video } = body;

  if (!file_id_hex || !isValidFileIdHex(file_id_hex)) {
    return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  }
  if (!file_key_hex || !/^[0-9a-f]{64}$/i.test(file_key_hex)) {
    return NextResponse.json({ error: "invalid file key" }, { status: 400 });
  }

  const dir = await mkdtemp(path.join(tmpdir(), "vault-thumb-"));
  const inPath = path.join(dir, "in");
  const outPath = path.join(dir, "out.jpg");

  try {
    const ciphertext = await fetchObjectCiphertext(file_id_hex, account);
    const fileKey = Buffer.from(file_key_hex, "hex");
    const { metadata, plaintext } = decryptPvltObject(ciphertext, fileKey, file_id_hex);

    const isHeic =
      metadata.mime_type.includes("heic") || metadata.filename.toLowerCase().endsWith(".heic");
    if (isHeic) {
      // Neither ffmpeg-static (no libheif) nor sharp's bundled libheif can
      // reliably decode real-world HEIC here -- the browser's WASM decoder
      // (heic-to) is the only thing that's actually worked for this format,
      // so leave HEIC thumbnails to the client-side fallback.
      return NextResponse.json({ error: "HEIC not supported server-side" }, { status: 422 });
    }

    await writeFile(inPath, plaintext);

    const args = is_video
      ? ["-y", "-ss", "0.5", "-i", inPath, "-frames:v", "1", "-vf", `scale='min(${THUMB_SIZE},iw)':-2`, outPath]
      : ["-y", "-i", inPath, "-frames:v", "1", "-vf", `scale='min(${THUMB_SIZE},iw)':-2`, outPath];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath as string, args);
      let stderr = "";
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      });
    });

    const jpeg = await readFile(outPath);
    return new NextResponse(jpeg as unknown as BodyInit, {
      status: 200,
      headers: { "Content-Type": "image/jpeg" },
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
