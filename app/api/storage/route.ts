// Aggregates quota/usedquota across every configured pCloud account (live,
// browsable in the gallery) so the UI can show a real "used / total" number.
// Also folds in `storage-summary.json` -- a small unencrypted file the local
// upload script (scripts/upload-iphone-pics.mjs) writes after each run,
// covering every rclone-backed account too (MEGA, Drive, extra pCloud
// remotes, ...). Those aren't browsable from here yet, just backup capacity,
// so they're only reflected in the grand total, not `accounts`.
import { NextResponse } from "next/server";
import { loadAccounts, getQuota, primaryAccount, ensureVaultFolder, getFileidInFolder, getFileLink } from "@/lib/pcloudServer";

interface StorageSummaryAccount {
  name: string;
  backend: string;
  quota: number | null;
  usedquota: number | null;
}

async function loadOtherBackendsTotal(): Promise<{ quota: number; usedquota: number; accounts: StorageSummaryAccount[] } | null> {
  try {
    const account = primaryAccount();
    const folderid = await ensureVaultFolder(account.token);
    const fileid = await getFileidInFolder(account.token, folderid, "storage-summary.json");
    if (fileid === null) return null;
    const link = await getFileLink(account.token, fileid);
    const summary = await (await fetch(link)).json();
    const others: StorageSummaryAccount[] = (summary.accounts ?? []).filter(
      (a: StorageSummaryAccount) => a.backend === "rclone" && typeof a.quota === "number" && typeof a.usedquota === "number"
    );
    return {
      quota: others.reduce((sum, a) => sum + (a.quota ?? 0), 0),
      usedquota: others.reduce((sum, a) => sum + (a.usedquota ?? 0), 0),
      accounts: others,
    };
  } catch {
    return null; // summary missing/unreachable -- just omit the extra total
  }
}

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

    const other = await loadOtherBackendsTotal();
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
