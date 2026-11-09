#!/usr/bin/env node
// Adds (or updates) one MEGA account in .env.local's MEGA_ACCOUNTS as a
// read-only PUBLIC FOLDER LINK to the remote's `vault` folder. The webapp
// never logs in to MEGA (many serverless logins from varying IPs got an
// account blocked), so no email/password is stored -- only the link, created
// here with one login from your machine. Everything in that folder is ciphertext.
//
// Usage (from webapp/):
//   node scripts/add-mega-account.mjs <rcloneRemoteName>
//   e.g. node scripts/add-mega-account.mjs mega
//
// The remote name becomes the account `name` -- manifest entries point at
// it, so never rename it once files have been uploaded.
//
// Afterwards, push the updated value to Vercel (remove + re-add
// MEGA_ACCOUNTS; see README).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [name] = process.argv.slice(2);
if (!name) {
  console.error("Usage: node scripts/add-mega-account.mjs <rcloneRemoteName>");
  process.exit(1);
}

const dump = JSON.parse(execFileSync("rclone", ["config", "dump"], { encoding: "utf8" }));
if (dump[name]?.type !== "mega") {
  console.error(`Remote ${name} is not a mega remote in rclone config.`);
  process.exit(1);
}
// rclone can't export MEGA *folder* links ("Access violation"), so do the
// one-time export with megajs: a single login from this machine, then done.
// The password is read from rclone's config and never printed or stored.
const { Storage, File } = await import("megajs");
const password = execFileSync("rclone", ["reveal", dump[name].pass], { encoding: "utf8" }).trim();
const storage = await new Storage({ email: dump[name].user, password, keepalive: false }).ready;
let vault = storage.root.children?.find((c) => c.directory && c.name === "vault");
if (!vault) {
  console.error(`No "vault" folder on ${name} yet -- upload something with rclone first.`);
  process.exit(1);
}
const folderLink = await vault.shareFolder({});
if (!/^https:\/\/mega\.nz\/folder\/[^#]+#.+/.test(folderLink)) {
  console.error(`Unexpected link: ${folderLink.slice(0, 40)}...`);
  process.exit(1);
}
await storage.close();

// Prove the link works with NO login before saving it.
const check = File.fromURL(folderLink);
await check.loadAttributes();
console.log(`Link OK: ${check.children?.length ?? 0} entries visible without logging in.`);

const envPath = path.resolve(process.cwd(), ".env.local");
const lines = readFileSync(envPath, "utf8").split("\n");
const idx = lines.findIndex((l) => l.startsWith("MEGA_ACCOUNTS="));
const accounts = idx >= 0 ? JSON.parse(lines[idx].slice("MEGA_ACCOUNTS=".length)) : [];
const entry = { name, folderLink };
const existing = accounts.findIndex((a) => a.name === name);
if (existing >= 0) accounts[existing] = entry;
else accounts.push(entry);
const serialized = `MEGA_ACCOUNTS=${JSON.stringify(accounts)}`;
if (idx >= 0) lines[idx] = serialized;
else lines.splice(lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, serialized);
writeFileSync(envPath, lines.join("\n"));

console.log(`${existing >= 0 ? "Updated" : "Added"} ${name} (folder link, no password stored).`);
console.log(`MEGA_ACCOUNTS in .env.local now has: ${accounts.map((a) => a.name).join(", ")}`);
console.log("Next: push it to Vercel (remove + re-add MEGA_ACCOUNTS).");

process.exit(0); // megajs keeps sockets open
