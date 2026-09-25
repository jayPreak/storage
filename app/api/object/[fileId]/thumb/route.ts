// Stored encrypted thumbnails. The browser generates a small JPEG once,
// encrypts it with a key derived from that file's own key
// (deriveThumbKey in lib/vaultCrypto.ts) and PUTs the ciphertext here; the
// gallery then GETs these few-KB blobs instead of regenerating a thumbnail
// from the multi-MB original on every device/visit. Like the object route,
// this only ever handles opaque ciphertext.
import { NextResponse } from "next/server";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import { accountByName, getFileLinkByPath, primaryAccount, uploadToPath } from "@/lib/pcloudServer";

const THUMBS_FOLDER = "/vault-thumbs";
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

// Thumbnails sit in the same account as their original (falling back to the
// primary account for legacy entries with no recorded account) so GET and
// PUT always agree on where to look.
function resolveAccount(req: Request) {
  const name = new URL(req.url).searchParams.get("account");
  return name ? accountByName(name) : primaryAccount();
}

export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  if (!isValidFileIdHex(fileId)) {
    return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  }
  const notFound = () =>
    NextResponse.json({ error: "no stored thumbnail" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    const account = resolveAccount(req);
    if (!account) return notFound();
    const link = await getFileLinkByPath(account.token, `${THUMBS_FOLDER}/${fileId}.pvlt`);
    if (!link) return notFound();
    const upstream = await fetch(link);
    if (!upstream.ok || !upstream.body) return notFound();
    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "thumbnail lookup failed" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  if (!isValidFileIdHex(fileId)) {
    return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  }
  const account = resolveAccount(req);
  if (!account) {
    return NextResponse.json({ error: "unknown account" }, { status: 400 });
  }
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0 || body.length > MAX_THUMB_BYTES) {
    return NextResponse.json({ error: "thumbnail too large" }, { status: 413 });
  }
  try {
    await uploadToPath(account.token, THUMBS_FOLDER, `${fileId}.pvlt`, body);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "thumbnail upload failed" },
      { status: 500 }
    );
  }
}
