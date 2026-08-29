// STAND-IN for cloud storage: vault.config.json lives in the primary
// pCloud account's vault folder alongside manifest.enc (it must live
// somewhere durable, since Vercel has no persistent disk). Falls back to
// the bundled local copy so the existing demo vault keeps working before
// the one-time migration has run. It must never see plaintext or hold
// vault keys -- it already doesn't, since it only serves opaque
// encrypted/plaintext-but-non-secret config bytes.
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { CONFIG_PATH } from "@/lib/vaultPaths";
import { primaryAccount, ensureVaultFolder, getFileidInFolder, getFileLink } from "@/lib/pcloudServer";

const CONFIG_FILENAME = "vault.config.json";

export async function GET() {
  try {
    const account = primaryAccount();
    const folderid = await ensureVaultFolder(account.token);
    const fileid = await getFileidInFolder(account.token, folderid, CONFIG_FILENAME);
    if (fileid !== null) {
      const link = await getFileLink(account.token, fileid);
      const upstream = await fetch(link);
      if (upstream.ok && upstream.body) {
        return new NextResponse(upstream.body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
  } catch {
    // fall through to local demo copy below
  }

  try {
    const data = await readFile(CONFIG_PATH);
    return new NextResponse(data, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "config not found" }, { status: 404 });
  }
}
