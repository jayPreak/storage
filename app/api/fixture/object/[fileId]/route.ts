// DEV/BENCH-ONLY fixture route: returns 404 unless the server env var
// VAULT_FIXTURE_DIR is set (it is never set on Vercel). See lib/fixtureServer.ts.
import { NextResponse } from "next/server";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import { fixtureDisabled, getFixtureState, objectCiphertext } from "@/lib/fixtureServer";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const off = fixtureDisabled();
  if (off) return off;
  const { fileId } = await params;
  if (!isValidFileIdHex(fileId)) return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  const state = await getFixtureState();
  const ct = await objectCiphertext(state, fileId);
  if (!ct) return NextResponse.json({ error: "object not found" }, { status: 404 });
  return new NextResponse(ct as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      // Mirrors /api/object: a file id's ciphertext decrypts to the same bytes forever.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const off = fixtureDisabled();
  if (off) return off;
  const { fileId } = await params;
  if (!isValidFileIdHex(fileId)) return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  const state = await getFixtureState();
  state.uploads.delete(fileId);
  state.thumbs.delete(fileId);
  state.files.delete(fileId);
  return NextResponse.json({ ok: true });
}
