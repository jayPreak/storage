// STAND-IN for cloud storage: manifest.enc lives in the primary pCloud
// account's vault folder (it must live somewhere durable across
// invocations, since it changes on every upload and Vercel has no
// persistent disk). Falls back to the bundled local copy so the existing
// demo vault keeps working before the one-time migration has run.
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { MANIFEST_PATH } from "@/lib/vaultPaths";
import { primaryAccount, ensureVaultFolder, getFileidInFolder, getFileLink, uploadCiphertext } from "@/lib/pcloudServer";

const MANIFEST_FILENAME = "manifest.enc";

export async function GET() {
  try {
    const account = primaryAccount();
    const folderid = await ensureVaultFolder(account.token);
    const fileid = await getFileidInFolder(account.token, folderid, MANIFEST_FILENAME);
    if (fileid !== null) {
      const link = await getFileLink(account.token, fileid);
      const upstream = await fetch(link);
      if (upstream.ok && upstream.body) {
        return new NextResponse(upstream.body, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
    }
  } catch {
    // fall through to local demo copy below
  }

  try {
    const data = await readFile(MANIFEST_PATH);
    return new NextResponse(data, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  } catch {
    return NextResponse.json({ error: "manifest not found" }, { status: 404 });
  }
}

export async function POST(req: Request) {
  try {
    const arrayBuffer = await req.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const account = primaryAccount();
    const folderid = await ensureVaultFolder(account.token);
    await uploadCiphertext(account.token, folderid, MANIFEST_FILENAME, buffer);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
