// This route never sees plaintext -- the body is already ciphertext
// produced client-side (encryptPvltObject output). It just picks a pCloud
// account with enough free quota and forwards the bytes.
import { NextResponse } from "next/server";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import { pickAccountForUpload, ensureVaultFolder, uploadCiphertext } from "@/lib/pcloudServer";

export async function POST(req: Request) {
  const { searchParams } = new URL(req.url);
  const fileId = searchParams.get("fileId") ?? "";
  const filename = searchParams.get("filename") ?? "";

  if (!isValidFileIdHex(fileId)) {
    return NextResponse.json({ error: "invalid file id" }, { status: 400 });
  }
  if (!filename) {
    return NextResponse.json({ error: "missing filename" }, { status: 400 });
  }

  try {
    const arrayBuffer = await req.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const account = await pickAccountForUpload(buffer.length);
    const folderid = await ensureVaultFolder(account.token);
    await uploadCiphertext(account.token, folderid, `${fileId}.pvlt`, buffer);

    return NextResponse.json({ account: account.name });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
