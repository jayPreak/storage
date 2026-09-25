// Aggregates quota/usedquota across every browsable account: pCloud (live
// userinfo) plus Backblaze B2 (operator-set quotaBytes, usage from the B2
// ledger in storage-summary.json -- B2 has no live usage API).
// Also folds in the rest of `storage-summary.json` -- the `accounts` list
// the local upload script (scripts/upload-iphone-pics.mjs) writes after
// each run, covering every rclone-backed account too (MEGA, Drive, extra
// pCloud remotes, ...). Those aren't browsable from here yet, just backup
// capacity, so they're only reflected in the grand total, not `accounts`.
import { NextResponse } from "next/server";
import { loadAccounts, getQuota } from "@/lib/pcloudServer";
import * as b2 from "@/lib/b2Server";
import { readStorageSummary, type StorageSummary } from "@/lib/storageServer";

interface StorageSummaryAccount {
  name: string;
  backend: string;
  quota: number | null;
  usedquota: number | null;
}

function otherBackendsTotal(
  summary: StorageSummary | null,
  excludeNames: Set<string>
): { quota: number; usedquota: number; accounts: StorageSummaryAccount[] } | null {
  if (!summary) return null;
  const others: StorageSummaryAccount[] = (summary.accounts ?? []).filter(
    (a) =>
      a.backend === "rclone" &&
      // A B2 bucket that's also an rclone remote is already counted live.
      !excludeNames.has(a.name) &&
      typeof a.quota === "number" &&
      typeof a.usedquota === "number"
  );
  return {
    quota: others.reduce((sum, a) => sum + (a.quota ?? 0), 0),
    usedquota: others.reduce((sum, a) => sum + (a.usedquota ?? 0), 0),
    accounts: others,
  };
}

export async function GET() {
  try {
    const accounts = loadAccounts();
    let quota = 0;
    let usedquota = 0;
    const perAccount: { name: string; backend: "pcloud" | "b2"; quota: number; usedquota: number }[] = [];
    for (const account of accounts) {
      try {
        const q = await getQuota(account.token);
        quota += q.quota;
        usedquota += q.usedquota;
        perAccount.push({ name: account.name, backend: "pcloud", quota: q.quota, usedquota: q.usedquota });
      } catch {
        // account unreachable -- skip it, don't fail the whole aggregate
      }
    }

    // summary missing/unreachable -- B2 shows as empty, extra total omitted
    const summary = await readStorageSummary().catch(() => null);

    const b2Accounts = b2.loadAccounts();
    for (const account of b2Accounts) {
      const used = summary?.b2?.[account.name]?.usedBytes ?? 0;
      quota += account.quotaBytes;
      usedquota += used;
      perAccount.push({ name: account.name, backend: "b2", quota: account.quotaBytes, usedquota: used });
    }

    const other = otherBackendsTotal(summary, new Set(b2Accounts.map((a) => a.name)));
    const grandQuota = quota + (other?.quota ?? 0);
    const grandUsedquota = usedquota + (other?.usedquota ?? 0);

    return NextResponse.json({
      quota,
      usedquota,
      accounts: perAccount,
      grandQuota,
      grandUsedquota,
      otherBackends: other?.accounts ?? [],
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
