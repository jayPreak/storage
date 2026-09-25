// DEV/BENCH-ONLY fixture route: returns 404 unless the server env var
// VAULT_FIXTURE_DIR is set (it is never set on Vercel). See lib/fixtureServer.ts.
// Same wire format as /api/manifest (nonce || AES-GCM(header_key, json)),
// kept in server memory for the life of the process.
import { NextResponse } from "next/server";
import { decryptManifest, encryptManifest } from "@/lib/vaultCrypto";
import { fixtureDisabled, getFixtureState } from "@/lib/fixtureServer";

export const dynamic = "force-dynamic";

export async function GET() {
  const off = fixtureDisabled();
  if (off) return off;
  const state = await getFixtureState();
  const blob = await encryptManifest(state.headerKey, state.manifest);
  return new NextResponse(blob as unknown as BodyInit, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  const off = fixtureDisabled();
  if (off) return off;
  const state = await getFixtureState();
  try {
    state.manifest = await decryptManifest(new Uint8Array(await req.arrayBuffer()), state.headerKey);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "manifest did not decrypt under the fixture key" }, { status: 400 });
  }
}
