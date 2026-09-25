// DEV/BENCH-ONLY fixture route: returns 404 unless the server env var
// VAULT_FIXTURE_DIR is set (it is never set on Vercel). See lib/fixtureServer.ts.
// Accepts the client's ciphertext like /api/upload, holds it in memory and
// simulates ~5 MB/s of upstream throughput per file.
import { NextResponse } from "next/server";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import { FIXTURE_UPLOAD_BYTES_PER_SEC, fixtureDisabled, getFixtureState, sleep } from "@/lib/fixtureServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const off = fixtureDisabled();
  if (off) return off;
  const { searchParams } = new URL(req.url);
  const fileId = searchParams.get("fileId") ?? "";
  if (!isValidFileIdHex(fileId)) return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  if (!searchParams.get("filename")) return NextResponse.json({ error: "missing filename" }, { status: 400 });
  const started = Date.now();
  const body = new Uint8Array(await req.arrayBuffer());
  const target = (body.length / FIXTURE_UPLOAD_BYTES_PER_SEC) * 1000;
  const remaining = target - (Date.now() - started);
  if (remaining > 0) await sleep(remaining);
  const state = await getFixtureState();
  state.uploads.set(fileId, body);
  return NextResponse.json({ backend: "fixture", account: "fixture" });
}
