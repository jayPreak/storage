// STAND-IN for cloud storage: proxies to pCloud via signed download links;
// it must never see plaintext or hold vault keys -- it already doesn't,
// since it only serves opaque encrypted .pvlt bytes fetched from pCloud.
// All decryption happens client-side.
import { NextResponse } from "next/server";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import { accountByName, findAccountHoldingFile, ensureVaultFolder, getFileidInFolder, getFileLink } from "@/lib/pcloudServer";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { fileId } = await params;
  const { searchParams } = new URL(req.url);
  const accountName = searchParams.get("account");

  // Path-safety: reject anything that isn't exactly a 32-hex-char id
  // BEFORE it is ever used to build a remote filename.
  if (!isValidFileIdHex(fileId)) {
    return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  }

  const filename = `${fileId}.pvlt`;

  try {
    const account = accountName ? accountByName(accountName) : await findAccountHoldingFile(filename);
    if (!account) {
      return NextResponse.json({ error: "object not found" }, { status: 404 });
    }

    const folderid = await ensureVaultFolder(account.token);
    const fileid = await getFileidInFolder(account.token, folderid, filename);
    if (fileid === null) {
      return NextResponse.json({ error: "object not found" }, { status: 404 });
    }

    const link = await getFileLink(account.token, fileid);
    const upstream = await fetch(link);
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: "object not found" }, { status: 404 });
    }

    return new NextResponse(upstream.body, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  } catch {
    return NextResponse.json({ error: "object not found" }, { status: 404 });
  }
}
