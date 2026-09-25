// DEV/BENCH-ONLY fixture route: returns 404 unless the server env var
// VAULT_FIXTURE_DIR is set (it is never set on Vercel). See lib/fixtureServer.ts.
// Hands the client the keys of the *synthetic* fixture vault (derived from a
// public constant, never from a passphrase) in place of the Argon2 unlock.
import { NextResponse } from "next/server";
import { fixtureDisabled, fixtureKeysHex, getFixtureState } from "@/lib/fixtureServer";

export const dynamic = "force-dynamic";

export async function GET() {
  const off = fixtureDisabled();
  if (off) return off;
  const state = await getFixtureState();
  return NextResponse.json(fixtureKeysHex(state), { headers: { "Cache-Control": "no-store" } });
}
