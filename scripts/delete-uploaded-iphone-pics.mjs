#!/usr/bin/env node
// Deletes local files from WATCH_DIR that upload-iphone-pics.mjs already
// confirmed as uploaded ("OK: ..." lines, and the "Full uploaded list"
// summary lines it prints at the end), skipped because they were already
// in the manifest ("SKIP (already in manifest): ..."), or skipped because
// they're empty ("SKIP (0 bytes): ..." -- nothing to lose, and they'd
// otherwise sit in the folder forever since they're never uploaded).
//
// Does NOT delete anything logged as FAIL -- those were never
// (successfully) uploaded.
//
// Since upload-iphone-pics.mjs now writes a fresh timestamped results file
// per run (~/vault-upload-results-<timestamp>.txt), pass the path to the
// run you want to act on. If omitted, this picks the most recently
// modified ~/vault-upload-results*.txt file.
//
// Usage:
//   node scripts/delete-uploaded-iphone-pics.mjs [resultsFile]            # dry run
//   node scripts/delete-uploaded-iphone-pics.mjs [resultsFile] --yes       # actually deletes

import { readFileSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const WATCH_DIR = path.join(os.homedir(), "Downloads", "iphone 1");

const DRY_RUN = !process.argv.includes("--yes");
const fileArg = process.argv.slice(2).find((a) => a !== "--yes");

function findLatestResultsFile() {
  const home = os.homedir();
  const candidates = readdirSync(home)
    .filter((f) => /^vault-upload-results.*\.txt$/.test(f))
    .map((f) => path.join(home, f));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

function main() {
  const RESULTS_PATH = fileArg ? path.resolve(fileArg) : findLatestResultsFile();

  if (!RESULTS_PATH || !existsSync(RESULTS_PATH)) {
    console.error(`Results file not found: ${RESULTS_PATH ?? "(none found in home dir)"}`);
    process.exit(1);
  }
  console.log(`Using results file: ${RESULTS_PATH}\n`);

  const lines = readFileSync(RESULTS_PATH, "utf8").split("\n");
  const toDelete = new Set();
  // Strip a leading "[timestamp] " prefix, if present, before matching.
  const stripTs = (s) => s.replace(/^\[[^\]]+\]\s?/, "");

  for (const rawLine of lines) {
    const line = stripTs(rawLine);
    let m;
    if ((m = line.match(/^OK: (.+?) \(\d+ bytes\) -> /))) {
      toDelete.add(m[1]);
    } else if ((m = line.match(/^\s{2}(.+?) \(\d+ bytes\) -> \S+$/))) {
      // "Full uploaded list" summary lines, e.g. "  IMG_0898.HEIC (1658890 bytes) -> pcloud2"
      toDelete.add(m[1]);
    } else if ((m = line.match(/^SKIP \((?:already in manifest|0 bytes)\): (.+)$/))) {
      toDelete.add(m[1]);
    }
  }

  if (toDelete.size === 0) {
    console.log("No OK/uploaded/SKIP (already in manifest / 0 bytes) entries found in results file.");
    return;
  }

  console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Found ${toDelete.size} file(s) to delete from ${WATCH_DIR}:\n`);

  let deleted = 0;
  let missing = 0;
  for (const filename of toDelete) {
    const fullPath = path.join(WATCH_DIR, filename);
    if (!existsSync(fullPath)) {
      console.log(`  MISSING (already gone): ${filename}`);
      missing++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`  would delete: ${filename}`);
    } else {
      unlinkSync(fullPath);
      console.log(`  deleted: ${filename}`);
      deleted++;
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Matched: ${toDelete.size}`);
  console.log(`Missing: ${missing}`);
  if (DRY_RUN) {
    console.log(`Dry run only -- re-run with --yes to actually delete these files.`);
  } else {
    console.log(`Deleted: ${deleted}`);
  }
}

main();
