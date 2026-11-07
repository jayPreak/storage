#!/usr/bin/env node
// Adds (or updates) one MEGA account in .env.local's MEGA_ACCOUNTS, using the
// credentials from an existing rclone `mega` remote of the same name. Never
// prints the password.
//
// Usage (from webapp/):
//   node scripts/add-mega-account.mjs <rcloneRemoteName> [quotaBytes]
//   e.g. node scripts/add-mega-account.mjs mega
//
// The remote name becomes the account `name` -- manifest entries point at
// it, so never rename it once files have been uploaded. quotaBytes is an
// optional cap below what MEGA itself reports.
//
// Afterwards, push the updated value to Vercel (see README).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [name, quotaArg] = process.argv.slice(2);
if (!name) {
  console.error("Usage: node scripts/add-mega-account.mjs <rcloneRemoteName> [quotaBytes]");
  process.exit(1);
}
const quotaBytes = quotaArg ? Number(quotaArg) : undefined;
if (quotaArg && (!Number.isFinite(quotaBytes) || quotaBytes <= 0)) {
  console.error(`Invalid quotaBytes: ${quotaArg}`);
  process.exit(1);
}

const dump = JSON.parse(execFileSync("rclone", ["config", "dump"], { encoding: "utf8" }));
const remote = dump[name];
if (!remote) {
  console.error(`No [${name}] remote in rclone config. Run \`rclone config\` first.`);
  process.exit(1);
}
if (remote.type !== "mega") {
  console.error(`Remote ${name} is type "${remote.type}", not mega.`);
  process.exit(1);
}
const email = remote.user;
// rclone stores the password obscured; `rclone reveal` reverses that.
const password = execFileSync("rclone", ["reveal", remote.pass], { encoding: "utf8" }).trim();
if (!email || !password) {
  console.error(`Remote ${name} is missing user/pass.`);
  process.exit(1);
}

const envPath = path.resolve(process.cwd(), ".env.local");
const lines = readFileSync(envPath, "utf8").split("\n");
const idx = lines.findIndex((l) => l.startsWith("MEGA_ACCOUNTS="));
const accounts = idx >= 0 ? JSON.parse(lines[idx].slice("MEGA_ACCOUNTS=".length)) : [];
const entry = { name, email, password, ...(quotaBytes ? { quotaBytes } : {}) };
const existing = accounts.findIndex((a) => a.name === name);
if (existing >= 0) accounts[existing] = entry;
else accounts.push(entry);
const serialized = `MEGA_ACCOUNTS=${JSON.stringify(accounts)}`;
if (idx >= 0) lines[idx] = serialized;
else lines.splice(lines[lines.length - 1] === "" ? lines.length - 1 : lines.length, 0, serialized);
writeFileSync(envPath, lines.join("\n"));

console.log(`${existing >= 0 ? "Updated" : "Added"} ${name} (${email}).`);
console.log(`MEGA_ACCOUNTS in .env.local now has: ${accounts.map((a) => a.name).join(", ")}`);
console.log("Next: push it to Vercel with `vercel env add MEGA_ACCOUNTS production`.");
