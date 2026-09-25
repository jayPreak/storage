// DEV/BENCH-ONLY fixture vault. Everything in here (and every route under
// app/api/fixture/) is inert unless the server env var VAULT_FIXTURE_DIR is
// set -- each fixture route returns 404 when it is unset. VAULT_FIXTURE_DIR
// is never set on Vercel, so production never serves any of this.
//
// Layout of VAULT_FIXTURE_DIR:
//   <dir>/bench-5k.json   array of {filename, captured_ts, mime_type, size, width, height}
//   <dir>/bench-5k/       the synthetic files themselves
//
// The fixture is a *synthetic* vault: its keys are derived from a fixed,
// public constant (below), not from any passphrase, and it holds only
// generated test files. The server encrypts those files on the fly with the
// real .pvlt / manifest formats, so the client runs its real
// fetch -> unwrap -> decrypt -> render path against them. State (manifest
// edits, uploads, stored thumbs) lives in this process's memory only.
import { readFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import ffmpegPath from "ffmpeg-static";
import {
  bytesToHex,
  deriveSubkeys,
  deriveThumbKey,
  encryptPvltObject,
  wrapFileKey,
  type Manifest,
  type ManifestEntry,
} from "@/lib/vaultCrypto";

export const FIXTURE_QUOTA_BYTES = 15 * 1024 * 1024 * 1024;
export const FIXTURE_UPLOAD_BYTES_PER_SEC = 5 * 1024 * 1024;
const FIXTURE_TRASH_COUNT = 40;
// Public constant -- this is a throwaway synthetic vault, not a secret.
const FIXTURE_ROOT_KEY = createHash("sha256").update("vault-fixture-mode-v1").digest();

interface FixtureSource {
  filename: string;
  captured_ts: number;
  mime_type: string;
  size: number;
  width?: number;
  height?: number;
}

interface FixtureState {
  headerKey: Uint8Array;
  wrapKey: Uint8Array;
  manifest: Manifest;
  // file id -> path of the fixture file on disk
  files: Map<string, { path: string; filename: string; mime: string }>;
  // file id -> ciphertext uploaded through the fixture upload route
  uploads: Map<string, Uint8Array>;
  // file id -> encrypted thumbnail PUT by the client
  thumbs: Map<string, Uint8Array>;
  // file id -> plaintext JPEG poster frame for fixture videos
  posters: Map<string, Promise<Uint8Array | null>>;
}

export function fixtureDir(): string | null {
  const dir = process.env.VAULT_FIXTURE_DIR;
  return dir && dir.trim() ? dir : null;
}

// Every fixture route calls this first and returns its result if non-null.
export function fixtureDisabled(): NextResponse | null {
  if (fixtureDir()) return null;
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export function fileKeyFor(fileIdHex: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", FIXTURE_ROOT_KEY).update(`file:${fileIdHex}`).digest());
}

function fileIdFor(filename: string): string {
  return createHash("sha256").update(`fixture:${filename}`).digest("hex").slice(0, 32);
}

// Shared across route bundles via globalThis (each route handler is its own
// module graph, so plain module state would not be shared).
const STATE_KEY = Symbol.for("vault.fixtureState");
type Holder = { [STATE_KEY]?: Promise<FixtureState> };

export function getFixtureState(): Promise<FixtureState> {
  const holder = globalThis as unknown as Holder;
  if (!holder[STATE_KEY]) {
    holder[STATE_KEY] = buildState().catch((e) => {
      delete holder[STATE_KEY];
      throw e;
    });
  }
  return holder[STATE_KEY]!;
}

async function buildState(): Promise<FixtureState> {
  const dir = fixtureDir();
  if (!dir) throw new Error("fixture mode disabled");
  const sources = JSON.parse(await readFile(path.join(dir, "bench-5k.json"), "utf8")) as FixtureSource[];
  const { headerKey, wrapKey } = await deriveSubkeys(new Uint8Array(FIXTURE_ROOT_KEY));

  // Deterministic trash picks: evenly spaced through the list.
  const step = Math.max(1, Math.floor(sources.length / FIXTURE_TRASH_COUNT));
  const trashIdx = new Set<number>();
  for (let i = 0; i < sources.length && trashIdx.size < FIXTURE_TRASH_COUNT; i += step) trashIdx.add(i + Math.floor(step / 2));

  const files: FixtureState["files"] = new Map();
  const entries: Record<string, ManifestEntry> = {};
  let i = 0;
  for (const src of sources) {
    const id = fileIdFor(src.filename);
    const { wrap_nonce_hex, wrapped_key_hex } = await wrapFileKey(wrapKey, id, fileKeyFor(id));
    files.set(id, { path: path.join(dir, "bench-5k", src.filename), filename: src.filename, mime: src.mime_type });
    entries[id] = {
      file_id_hex: id,
      wrap_nonce_hex,
      wrapped_key_hex,
      object_path: `objects/${id}.pvlt`,
      filename: src.filename,
      mime_type: src.mime_type,
      size: src.size,
      captured_ts: src.captured_ts,
      // Imported a little while after capture, deterministic per index.
      added_ts: src.captured_ts + 600 + (i % 97) * 3600,
      deleted: trashIdx.has(i),
      extra: { backend: "fixture", backend_account: "fixture" },
    };
    i++;
  }
  const now = Date.now() / 1000;
  return {
    headerKey,
    wrapKey,
    manifest: { created_ts: now, updated_ts: now, entries },
    files,
    uploads: new Map(),
    thumbs: new Map(),
    posters: new Map(),
  };
}

// Real .pvlt ciphertext for an object (fixture file encrypted on the fly,
// or the bytes an earlier fixture upload stored). null = not found.
export async function objectCiphertext(state: FixtureState, id: string): Promise<Uint8Array | null> {
  const uploaded = state.uploads.get(id);
  if (uploaded) return uploaded;
  const file = state.files.get(id);
  if (!file) return null;
  const plain = new Uint8Array(await readFile(file.path));
  return encryptPvltObject(plain, fileKeyFor(id), id, {
    filename: file.filename,
    mime_type: file.mime,
    created_ts: state.manifest.entries[id]?.added_ts ?? 0,
  });
}

// Encrypted thumbnail, in the same format the client stores via PUT: the
// fixture JPEG itself (already ~800px) or an ffmpeg poster for videos.
export async function thumbCiphertext(state: FixtureState, id: string): Promise<Uint8Array | null> {
  const stored = state.thumbs.get(id);
  if (stored) return stored;
  const file = state.files.get(id);
  if (!file) return null;
  let jpeg: Uint8Array | null;
  if (file.mime.startsWith("video/")) {
    let p = state.posters.get(id);
    if (!p) {
      p = posterFrame(file.path).catch(() => null);
      state.posters.set(id, p);
    }
    jpeg = await p;
  } else {
    jpeg = new Uint8Array(await readFile(file.path));
  }
  if (!jpeg) return null;
  const enc = await encryptPvltObject(jpeg, await deriveThumbKey(fileKeyFor(id)), id, {
    filename: `${file.filename}.thumb.jpg`,
    mime_type: "image/jpeg",
    created_ts: 0,
  });
  state.thumbs.set(id, enc);
  return enc;
}

async function posterFrame(inPath: string): Promise<Uint8Array | null> {
  if (!ffmpegPath) return null;
  const dir = await mkdtemp(path.join(tmpdir(), "vault-fixture-poster-"));
  const outPath = path.join(dir, "out.jpg");
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath as string, [
        "-y", "-ss", "0.5", "-i", inPath, "-frames:v", "1", "-vf", "scale='min(480,iw)':-2", outPath,
      ]);
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    return new Uint8Array(await readFile(outPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function fixtureKeysHex(state: FixtureState) {
  return { header_key_hex: bytesToHex(state.headerKey), wrap_key_hex: bytesToHex(state.wrapKey) };
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
