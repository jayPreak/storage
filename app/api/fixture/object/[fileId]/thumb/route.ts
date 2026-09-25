// DEV/BENCH-ONLY fixture route: returns 404 unless the server env var
// VAULT_FIXTURE_DIR is set (it is never set on Vercel). See lib/fixtureServer.ts.
import { NextResponse } from "next/server";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import { fixtureDisabled, getFixtureState, thumbCiphertext } from "@/lib/fixtureServer";

export const dynamic = "force-dynamic";
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

export async function GET(_req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const off = fixtureDisabled();
  if (off) return off;
  const { fileId } = await params;
  if (!isValidFileIdHex(fileId)) return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  const state = await getFixtureState();
  const ct = await thumbCiphertext(state, fileId);
  if (!ct) {
    return NextResponse.json({ error: "no stored thumbnail" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return new NextResponse(ct as unknown as BodyInit, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=31536000, immutable" },
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const off = fixtureDisabled();
  if (off) return off;
  const { fileId } = await params;
  if (!isValidFileIdHex(fileId)) return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0 || body.length > MAX_THUMB_BYTES) {
    return NextResponse.json({ error: "thumbnail too large" }, { status: 413 });
  }
  const state = await getFixtureState();
  state.thumbs.set(fileId, body);
  return NextResponse.json({ ok: true });
}
