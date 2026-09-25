// DEV/BENCH-ONLY fixture route: returns 404 unless the server env var
// VAULT_FIXTURE_DIR is set (it is never set on Vercel). See lib/fixtureServer.ts.
// Fixture objects have no server-side thumbnail path: 422 sends the client down
// its existing fallback (in-browser decode / play the original).
import { NextResponse } from "next/server";
import { fixtureDisabled } from "@/lib/fixtureServer";

export const dynamic = "force-dynamic";

export async function POST() {
  const off = fixtureDisabled();
  if (off) return off;
  return NextResponse.json({ error: "not available in fixture mode" }, { status: 422 });
}
