#!/usr/bin/env node
// Adds (or updates) one Backblaze B2 account in .env.local's B2_ACCOUNTS,
// using the credentials from an existing rclone remote of the same name.
// It resolves the bucketId once (B2's upload API needs it) and checks the
// key can actually reach the bucket. Never prints the key.
//
// Usage (from webapp/):
//   node scripts/add-b2-account.mjs <rcloneRemoteName> <bucketName> [quotaBytes]
//   e.g. node scripts/add-b2-account.mjs b2second vault-b2second
//
// quotaBytes defaults to 10000000000 (B2's 10GB free tier). The remote name
// becomes the account `name` -- manifest entries point at it, so never
// rename it once files have been uploaded.
//
// Afterwards, push the updated value to Vercel (see README "Adding another
// B2 account").
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [name, bucketName, quotaArg] = process.argv.slice(2);
if (!name || !bucketName) {
  console.error("Usage: node scripts/add-b2-account.mjs <rcloneRemoteName> <bucketName> [quotaBytes]");
  process.exit(1);
}
const quotaBytes = quotaArg ? Number(quotaArg) : 10_000_000_000;
if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
  console.error(`Invalid quotaBytes: ${quotaArg}`);
  process.exit(1);
}

// ---- rclone remote -> keyId / applicationKey ----
const confPath = execFileSync("rclone", ["config", "file"], { encoding: "utf8" }).trim().split("\n").pop();
const conf = readFileSync(confPath, "utf8");
const section = conf.split(new RegExp(`^\\[${name}\\]$`, "m"))[1]?.split(/^\[/m)[0];
if (!section) {
  console.error(`No [${name}] remote in ${confPath}. Run \`rclone config\` first.`);
  process.exit(1);
}
const field = (k) => section.match(new RegExp(`^${k}\\s*=\\s*(.*)$`, "m"))?.[1].trim();
if (field("type") !== "b2") {
  console.error(`Remote ${name} is type "${field("type")}", not b2.`);
  process.exit(1);
}
const keyId = field("account");
const applicationKey = field("key");
if (!keyId || !applicationKey) {
  console.error(`Remote ${name} is missing account/key fields.`);
  process.exit(1);
}

// ---- resolve bucketId + sanity-check access ----
const basic = Buffer.from(`${keyId}:${applicationKey}`).toString("base64");
const authRes = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
  headers: { Authorization: `Basic ${basic}` },
});
if (!authRes.ok) {
  console.error(`B2 authorize failed: HTTP ${authRes.status} -- check the key in rclone config.`);
  process.exit(1);
}
const auth = await authRes.json();
const listRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_buckets`, {
  method: "POST",
  headers: { Authorization: auth.authorizationToken },
  body: JSON.stringify({ accountId: auth.accountId, bucketName }),
});
const bucket = listRes.ok ? (await listRes.json()).buckets?.[0] : undefined;
if (!bucket) {
  console.error(`Bucket ${bucketName} not found or not visible to this key (HTTP ${listRes.status}).`);
  process.exit(1);
}
if (bucket.bucketType !== "allPrivate") {
  console.error(`Bucket ${bucketName} is "${bucket.bucketType}" -- make it Private first.`);
  process.exit(1);
}
const caps = auth.allowed?.capabilities ?? [];
const missing = ["listBuckets", "listFiles", "readFiles", "writeFiles", "deleteFiles"].filter((c) => !caps.includes(c));
if (missing.length) {
  console.error(`Key is missing capabilities: ${missing.join(", ")}. Create a Read and Write key.`);
  process.exit(1);
}

// ---- write .env.local ----
const envPath = path.resolve(process.cwd(), ".env.local");
const lines = readFileSync(envPath, "utf8").split("\n");
const idx = lines.findIndex((l) => l.startsWith("B2_ACCOUNTS="));
const accounts = idx >= 0 ? JSON.parse(lines[idx].slice("B2_ACCOUNTS=".length)) : [];
const entry = { name, keyId, applicationKey, bucketId: bucket.bucketId, bucketName, quotaBytes };
const existing = accounts.findIndex((a) => a.name === name);
if (existing >= 0) accounts[existing] = entry;
else accounts.push(entry); // appended = filled after every earlier account
const serialized = `B2_ACCOUNTS=${JSON.stringify(accounts)}`;
if (idx >= 0) lines[idx] = serialized;
else lines.splice(lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, serialized);
writeFileSync(envPath, lines.join("\n"));

console.log(`${existing >= 0 ? "Updated" : "Added"} ${name} (bucket ${bucketName}, id ${bucket.bucketId}, quota ${quotaBytes} bytes).`);
console.log(`B2_ACCOUNTS in .env.local now has: ${accounts.map((a) => a.name).join(", ")}`);
console.log("Next: push it to Vercel -- see README \"Adding another B2 account\".");
