// This route never sees plaintext -- the body is already ciphertext
// produced client-side (encryptPvltObject output). It just picks a storage
// account (pCloud or B2) with enough free space and forwards the bytes.
import { NextResponse } from "next/server";
import { isValidFileIdHex } from "@/lib/vaultPaths";
import * as pcloud from "@/lib/pcloudServer";
import * as b2 from "@/lib/b2Server";
import { pickAccountForUpload, adjustB2UsageBestEffort } from "@/lib/storageServer";

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

    const picked = await pickAccountForUpload(buffer.length);
    if (picked.backend === "b2") {
      const account = b2.accountByName(picked.name)!;
      await b2.uploadCiphertext(account, `${fileId}.pvlt`, buffer);
      await adjustB2UsageBestEffort(account.name, buffer.length);
    } else {
      const account = pcloud.accountByName(picked.name)!;
      const folderid = await pcloud.ensureVaultFolder(account.token);
      await pcloud.uploadCiphertext(account.token, folderid, `${fileId}.pvlt`, buffer);
    }

    return NextResponse.json({ backend: picked.backend, account: picked.name });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
