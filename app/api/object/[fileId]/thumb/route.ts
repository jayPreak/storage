// Stored encrypted thumbnails. The browser generates a small JPEG once,
// encrypts it with a key derived from that file's own key
// (deriveThumbKey in lib/vaultCrypto.ts) and PUTs the ciphertext here; the
// gallery then GETs these few-KB blobs instead of regenerating a thumbnail
// from the multi-MB original on every device/visit. Like the object route,
// this only ever handles opaque ciphertext.
import { NextResponse } from "next/server";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import { accountByName, getFileLinkByPath, primaryAccount, uploadToPath } from "@/lib/pcloudServer";
import * as b2 from "@/lib/b2Server";
import { adjustB2UsageBestEffort, parseBackendParam, type ResolvedAccount } from "@/lib/storageServer";

const THUMBS_FOLDER = "/vault-thumbs";
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

// Thumbnails sit in the same account as their original (falling back to the
// primary pCloud account for legacy entries with no recorded account) so
// GET and PUT always agree on where to look. B2 thumbs live under
// b2.THUMBS_PREFIX in the original's bucket.
function resolveAccount(req: Request): ResolvedAccount | null {
  const searchParams = new URL(req.url).searchParams;
  const name = searchParams.get("account");
  const backend = parseBackendParam(searchParams.get("backend"));
  if (backend === "b2") {
    const account = name ? b2.accountByName(name) : undefined;
    return account ? { backend, account } : null;
  }
  if (backend === "pcloud") {
    const account = name ? accountByName(name) : primaryAccount();
    return account ? { backend, account } : null;
  }
  return null;
}

export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  if (!isValidFileIdHex(fileId)) {
    return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  }
  const notFound = () =>
    NextResponse.json({ error: "no stored thumbnail" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    const resolved = resolveAccount(req);
    if (!resolved) return notFound();
    let upstream: Response | null;
    if (resolved.backend === "b2") {
      upstream = await b2.downloadFile(resolved.account, `${b2.THUMBS_PREFIX}${fileId}.pvlt`);
    } else {
      const link = await getFileLinkByPath(resolved.account.token, `${THUMBS_FOLDER}/${fileId}.pvlt`);
      upstream = link ? await fetch(link) : null;
    }
    if (!upstream?.ok || !upstream.body) return notFound();
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
  const resolved = resolveAccount(req);
  if (!resolved) {
    return NextResponse.json({ error: "unknown account" }, { status: 400 });
  }
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0 || body.length > MAX_THUMB_BYTES) {
    return NextResponse.json({ error: "thumbnail too large" }, { status: 413 });
  }
  try {
    if (resolved.backend === "b2") {
      await b2.uploadFile(resolved.account, `${b2.THUMBS_PREFIX}${fileId}.pvlt`, body);
      await adjustB2UsageBestEffort(resolved.account.name, body.length);
    } else {
      await uploadToPath(resolved.account.token, THUMBS_FOLDER, `${fileId}.pvlt`, body);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "thumbnail upload failed" },
      { status: 500 }
    );
  }
}
