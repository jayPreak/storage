// DEV/BENCH-ONLY fixture route: returns 404 unless the server env var
// VAULT_FIXTURE_DIR is set (it is never set on Vercel). See lib/fixtureServer.ts.
import { NextResponse } from "next/server";
import { FIXTURE_QUOTA_BYTES, fixtureDisabled, getFixtureState } from "@/lib/fixtureServer";

export const dynamic = "force-dynamic";

export async function GET() {
  const off = fixtureDisabled();
  if (off) return off;
  const state = await getFixtureState();
  const used = Object.values(state.manifest.entries).reduce((n, e) => n + (e.size || 0), 0);
  return NextResponse.json({
    quota: FIXTURE_QUOTA_BYTES,
    usedquota: used,
    accounts: [{ name: "fixture", backend: "fixture", quota: FIXTURE_QUOTA_BYTES, usedquota: used }],
    grandQuota: FIXTURE_QUOTA_BYTES,
    grandUsedquota: used,
    otherBackends: [],
  });
}
