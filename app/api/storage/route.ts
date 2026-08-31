// Aggregates quota/usedquota across every configured pCloud account so the
// UI can show one real "used / total" number instead of a made-up one.
import { NextResponse } from "next/server";
import { loadAccounts, getQuota } from "@/lib/pcloudServer";

export async function GET() {
  try {
    const accounts = loadAccounts();
    let quota = 0;
    let usedquota = 0;
    const perAccount: { name: string; quota: number; usedquota: number }[] = [];
    for (const account of accounts) {
      try {
        const q = await getQuota(account.token);
        quota += q.quota;
        usedquota += q.usedquota;
        perAccount.push({ name: account.name, quota: q.quota, usedquota: q.usedquota });
      } catch {
        // account unreachable -- skip it, don't fail the whole aggregate
      }
    }
    return NextResponse.json({ quota, usedquota, accounts: perAccount });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
