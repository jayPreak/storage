// STAND-IN for cloud storage: proxies to pCloud via signed download links;
// it must never see plaintext or hold vault keys -- it already doesn't,
// since it only serves opaque encrypted .pvlt bytes fetched from pCloud.
// All decryption happens client-side.
import { NextResponse } from "next/server";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import { accountByName, findAccountHoldingFile, ensureVaultFolder, getFileidInFolder, getFileLink, deleteFile, deleteByPath, primaryAccount } from "@/lib/pcloudServer";

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
      headers: {
        "Content-Type": "application/octet-stream",
        // Ciphertext for a given file id never changes, so it's safe (and
        // fast) for the browser to cache it indefinitely instead of
        // re-fetching from pCloud every time a tile/thumbnail is opened.
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "object not found" }, { status: 404 });
  }
}

// Called from "Delete permanently" so the encrypted blob is actually
// removed from pCloud, not just forgotten from the local manifest.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { fileId } = await params;
  const { searchParams } = new URL(req.url);
  const accountName = searchParams.get("account");

  if (!isValidFileIdHex(fileId)) {
    return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  }

  const filename = `${fileId}.pvlt`;

  try {
    const account = accountName ? accountByName(accountName) : await findAccountHoldingFile(filename);
    if (!account) {
      // Nothing to delete -- already gone from cloud storage.
      return NextResponse.json({ ok: true, alreadyGone: true });
    }

    const folderid = await ensureVaultFolder(account.token);
    const fileid = await getFileidInFolder(account.token, folderid, filename);
    if (fileid === null) {
      return NextResponse.json({ ok: true, alreadyGone: true });
    }

    await deleteFile(account.token, fileid);
    // Best-effort: also drop the stored thumbnail (see ./thumb/route.ts for
    // which account it lives in). An orphaned thumb is harmless ciphertext.
    const thumbAccount = accountName ? account : primaryAccount();
    await deleteByPath(thumbAccount.token, `/vault-thumbs/${fileId}.pvlt`).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "delete failed" },
      { status: 500 }
    );
  }
}
