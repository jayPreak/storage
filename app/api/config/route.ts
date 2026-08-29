// STAND-IN for cloud storage: in production this route would instead proxy
// to R2/B2/Filen etc via signed URLs; it must never see plaintext or hold
// vault keys -- it already doesn't, since it only serves opaque
// encrypted/plaintext-but-non-secret config bytes read straight off disk.
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { CONFIG_PATH } from "@/lib/vaultPaths";

export async function GET() {
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
