"use client";

import { useEffect, useRef, useState } from "react";
import {
  deriveMasterKey,
  deriveSubkeys,
  decryptManifest,
  unwrapFileKey,
  decryptPvltObject,
  encryptPvltObject,
  wrapFileKey,
  encryptManifest,
  deriveThumbKey,
  bytesToHex,
  type VaultConfig,
  type Manifest,
  type ManifestEntry,
} from "@/lib/vaultCrypto";
import { convertHeicToJpeg, canDecodeNatively } from "@/lib/heicConvert";
import { createLimiter } from "@/lib/limiter";
import { extractCapturedTs } from "@/lib/captureDate";
import { getCachedThumb, putCachedThumb } from "@/lib/thumbCache";
import { getCachedVideo, putCachedVideo } from "@/lib/videoCache";
import { useGridGestures } from "./useGridGestures";
import styles from "./page.module.css";

type UnlockedState = {
  wrapKey: Uint8Array;
  headerKey: Uint8Array;
  manifest: Manifest;
};

type OpenState = {
  entry: ManifestEntry;
  objectUrl: string | null;
  mime: string;
  note: string;
  downloadBlob: Blob | null;
  loading: boolean;
  placeholderUrl: string | null;
};

type Zoom = "S" | "M" | "L" | "XL";
type View = "library" | "photos" | "videos" | "trash" | "folders";
type Theme = "dark" | "light";
type FolderPath = { year?: number; month?: number; day?: number };

function capturedOf(entry: ManifestEntry): number {
  return entry.captured_ts ?? entry.added_ts;
}

// Module-level so the React compiler's purity lint doesn't mistake the
// async handler that calls it for render code.
function nowSec(): number {
  return Date.now() / 1000;
}

function isVideoEntry(entry: ManifestEntry): boolean {
  return (
    entry.mime_type.includes("quicktime") ||
    entry.mime_type.startsWith("video/") ||
    /\.(mov|mp4|m4v|webm)$/i.test(entry.filename)
  );
}

const VIEW_TITLES: Record<View, string> = {
  library: "Library",
  photos: "Photos",
  videos: "Videos",
  trash: "Trash",
  folders: "Folders",
};

// Small inline stroke icons for nav + mobile chrome (inherit currentColor).
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    library: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    photos: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="8.5" cy="9.5" r="1.8" /><path d="M21 16l-5-5-8 9" /></>,
    videos: <><rect x="3" y="5" width="13" height="14" rx="2.5" /><path d="M16 10l5-3v10l-5-3z" /></>,
    folders: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
    trash: <><path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13" /></>,
    close: <path d="M6 6l12 12M18 6L6 18" />,
    download: <><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></>,
    restore: <><path d="M4 12a8 8 0 108-8 8 8 0 00-6 2.7L4 9" /><path d="M4 4v5h5" /></>,
    upload: <><path d="M12 20V9M7 14l5-5 5 5M5 4h14" /></>,
    check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    moon: <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[name]}
    </svg>
  );
}

const THUMB_SIZE = 240;
const ZOOM_PX: Record<Zoom, number> = { S: 120, M: 168, L: 226, XL: 300 };

async function makeImageThumbnail(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB_SIZE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.75)
  );
}

// iOS Safari aborts a blob download if the URL is revoked synchronously
// right after click(), so give it time to start before releasing it.
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function formatBytes(n: number): string {
  if (!n || n <= 0) return "0 GB";
  const gb = n / (1024 * 1024 * 1024);
  return gb >= 10 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`;
}

function dateGroupLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const startOfDay = (dt: Date) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

// Thumbnail pipeline limits. Fetching an already-stored encrypted thumbnail
// is cheap (a few KB), so that queue is wide. Generating one is expensive
// -- the full original has to be downloaded and decoded, either by
// /api/thumbnail (ffmpeg) or in this tab for HEIC -- so those queues are
// narrow, and videos (which can take a minute server-side) get their own
// so they can't starve photos. The client decode limiter keeps heavy
// in-browser decodes to one at a time; unbounded parallel decodes are what
// used to run phones (and even desktop Chrome) out of memory.
const storedThumbLimiter = createLimiter(6);
const photoThumbLimiter = createLimiter(3);
const videoThumbLimiter = createLimiter(1);
const clientDecodeLimiter = createLimiter(1);
const SERVER_THUMB_TIMEOUT_MS = 60_000;
// Permanent deletes (e.g. emptying a big Trash) run a few at a time.
const cloudDeleteLimiter = createLimiter(4);

function accountQs(entry: ManifestEntry): string {
  return entry.extra?.pcloud_account
    ? `?account=${encodeURIComponent(String(entry.extra.pcloud_account))}`
    : "";
}

function isHeicEntry(mime: string, filename: string): boolean {
  return mime.includes("heic") || mime.includes("heif") || /\.hei[cf]$/i.test(filename);
}

// Stored thumbnails: generated once (by whichever device first needs
// one), encrypted under a key derived from the file key, and kept in
// pCloud -- so after that every device just downloads a few KB per tile.
async function fetchStoredThumb(entry: ManifestEntry, fileKey: Uint8Array): Promise<Blob | null> {
  try {
    const res = await fetch(`/api/object/${entry.file_id_hex}/thumb${accountQs(entry)}`);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const { plaintext } = await decryptPvltObject(buf, await deriveThumbKey(fileKey), entry.file_id_hex);
    return new Blob([plaintext as BlobPart], { type: "image/jpeg" });
  } catch {
    return null;
  }
}

async function storeThumb(entry: ManifestEntry, fileKey: Uint8Array, blob: Blob): Promise<void> {
  try {
    const enc = await encryptPvltObject(
      new Uint8Array(await blob.arrayBuffer()),
      await deriveThumbKey(fileKey),
      entry.file_id_hex,
      { filename: `${entry.filename}.thumb.jpg`, mime_type: "image/jpeg", created_ts: Date.now() / 1000 }
    );
    await fetch(`/api/object/${entry.file_id_hex}/thumb${accountQs(entry)}`, {
      method: "PUT",
      body: enc as BodyInit,
    });
  } catch {
    // Best-effort; it'll just be regenerated next time.
  }
}

// Shared IntersectionObserver per scroll container. Tiles live inside an
// overflow:auto container, so the observer's root has to be that container
// (not the viewport) for rootMargin to actually prefetch rows just below
// the fold.
const nearObservers = new Map<Element | null, IntersectionObserver>();
const nearCallbacks = new Map<Element, (near: boolean) => void>();
function observeNear(el: Element, cb: (near: boolean) => void): () => void {
  const root = el.closest("[data-scroll-root]");
  let observer = nearObservers.get(root);
  if (!observer) {
    observer = new IntersectionObserver(
      (records) => {
        for (const r of records) nearCallbacks.get(r.target)?.(r.isIntersecting);
      },
      { root, rootMargin: "800px 0px" }
    );
    nearObservers.set(root, observer);
  }
  nearCallbacks.set(el, cb);
  observer.observe(el);
  const obs = observer;
  return () => {
    nearCallbacks.delete(el);
    obs.unobserve(el);
  };
}

// Queue priority for a tile, computed from where it is *now*: tiles inside
// the visible area rank top-to-bottom (then left-to-right), then tiles just
// below the fold, then ones just above it. Lower runs first.
function tilePriority(el: Element): number {
  if (!el.isConnected) return Infinity;
  const root = el.closest("[data-scroll-root]");
  const view = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const r = el.getBoundingClientRect();
  const viewH = view.bottom - view.top;
  const tieBreak = r.left / 100_000;
  if (r.bottom < view.top) return viewH + (view.top - r.bottom) + tieBreak;
  return r.top - view.top + tieBreak;
}

type TileProps = {
  entry: ManifestEntry;
  thumbUrl: string | undefined;
  selected: boolean;
  loading: boolean;
  onTileClick: (entry: ManifestEntry, e: React.MouseEvent) => void;
  onCheckClick: (entry: ManifestEntry, e: React.MouseEvent) => void;
  onNearChange: (entry: ManifestEntry, near: boolean, el: Element) => void;
};

function Tile({ entry, thumbUrl, selected, loading, onTileClick, onCheckClick, onNearChange }: TileProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const onNearRef = useRef(onNearChange);
  useEffect(() => {
    onNearRef.current = onNearChange;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeNear(el, (isNear) => {
      setNear(isNear);
      onNearRef.current(entry, isNear, el);
    });
  }, [entry]);

  const isHeic = isHeicEntry(entry.mime_type, entry.filename);
  const isVideo = isVideoEntry(entry);
  return (
    <div
      ref={ref}
      data-tile-id={entry.file_id_hex}
      className={`${styles.tile} ${selected ? styles.tileSelected : ""}`}
      onClick={(e) => onTileClick(entry, e)}
    >
      {/* Only keep the <img> mounted while the tile is near the viewport,
          so thousands of decoded thumbnails aren't all held in memory at
          once on a long scroll (iOS Safari kills the tab well before
          desktop browsers would). */}
      {thumbUrl && near ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumbUrl} alt={entry.filename} className={styles.thumbImg} decoding="async" draggable={false} />
      ) : (
        <div className={styles.tilePlaceholder}>
          <div className={styles.tileIcon}>{isVideo ? "\u{1F3A5}" : "\u{1F5BC}️"}</div>
        </div>
      )}
      <div className={styles.tileOverlay}>
        <div className={styles.tileName}>{entry.filename}</div>
        <div className={styles.tileMeta}>
          {(entry.size / 1024).toFixed(0)} KiB
          {isHeic ? " · HEIC" : ""}
        </div>
      </div>
      <button
        className={styles.checkBtn}
        data-selected={selected}
        onClick={(e) => {
          e.stopPropagation();
          onCheckClick(entry, e);
        }}
        aria-label={selected ? "Deselect" : "Select"}
      >
        <span className={styles.checkBox}>{selected && <Icon name="check" size={13} />}</span>
      </button>
      {isVideo && <div className={styles.videoBadge}>▶</div>}
      <div className={styles.lockBadge}>🔒</div>
      {loading && (
        <div className={styles.tileLoading}>
          <span className={styles.spinner} />
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [unlocked, setUnlocked] = useState<UnlockedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

  const [open, setOpen] = useState<OpenState | null>(null);
  const openIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbsRequested = useRef<Set<string>>(new Set());

  // ---- Design-driven UI state ----
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    const saved = window.localStorage.getItem("vault-theme");
    return saved === "light" ? "light" : "dark";
  });
  const [zoom, setZoom] = useState<Zoom>(() => {
    if (typeof window === "undefined") return "M";
    const saved = window.localStorage.getItem("vault-zoom");
    return saved && ["S", "M", "L", "XL"].includes(saved) ? (saved as Zoom) : "M";
  });
  const [view, setView] = useState<View>("library");
  const [folderPath, setFolderPath] = useState<FolderPath>({});
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [isMobile, setIsMobile] = useState(false);
  const [storage, setStorage] = useState<{ used: number; quota: number; grandUsed: number; grandQuota: number } | null>(null);
  const [notice, setNotice] = useState<string>("");
  // Explicit "Select" mode (mobile toolbar button / long-press). On top of
  // that, having anything selected always counts as selecting, so a plain
  // click on a tile toggles it instead of opening it.
  const [selectMode, setSelectMode] = useState(false);
  const [mobileCols, setMobileCols] = useState<number>(() => {
    if (typeof window === "undefined") return 4;
    const saved = Number(window.localStorage.getItem("vault-mobile-cols"));
    return saved >= 2 && saved <= 6 ? saved : 4;
  });
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [confirmState, setConfirmState] = useState<
    | { title: string; body: string; confirmLabel: string; danger: boolean; resolve: (ok: boolean) => void }
    | null
  >(null);

  function askConfirm(opts: { title: string; body: string; confirmLabel: string; danger?: boolean }) {
    return new Promise<boolean>((resolve) =>
      setConfirmState({ ...opts, danger: opts.danger ?? false, resolve })
    );
  }
  function settleConfirm(ok: boolean) {
    confirmState?.resolve(ok);
    setConfirmState(null);
  }

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 860);
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("vault-theme", theme);
  }, [theme]);
  useEffect(() => {
    window.localStorage.setItem("vault-zoom", zoom);
  }, [zoom]);
  useEffect(() => {
    window.localStorage.setItem("vault-mobile-cols", String(mobileCols));
  }, [mobileCols]);

  function changeView(next: View) {
    setView(next);
    setFolderPath({});
    setSelectedIds({});
    setSelectMode(false);
    setSelectionAnchor(null);
  }

  useEffect(() => {
    if (!unlocked) return;
    fetch("/api/storage")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && typeof j.quota === "number") {
          setStorage({
            used: j.usedquota,
            quota: j.quota,
            grandUsed: typeof j.grandUsedquota === "number" ? j.grandUsedquota : j.usedquota,
            grandQuota: typeof j.grandQuota === "number" ? j.grandQuota : j.quota,
          });
        }
      })
      .catch(() => {});
  }, [unlocked]);

  const allEntries = unlocked ? Object.values(unlocked.manifest.entries) : [];
  const libraryEntries = allEntries.filter((e) => !e.deleted);
  const trashEntries = allEntries.filter((e) => e.deleted);
  const videoEntries = libraryEntries.filter(isVideoEntry);
  const photoEntries = libraryEntries.filter((e) => !isVideoEntry(e));
  const baseEntries =
    view === "trash"
      ? trashEntries
      : view === "photos"
      ? photoEntries
      : view === "videos"
      ? videoEntries
      : libraryEntries;
  const searchLower = search.trim().toLowerCase();
  const visibleEntries = (searchLower
    ? baseEntries.filter((e) => e.filename.toLowerCase().includes(searchLower))
    : baseEntries
  ).sort((a, b) => capturedOf(b) - capturedOf(a));


  // Group visible entries by day, preserving desc-sorted order.
  const dateGroups: { label: string; entries: ManifestEntry[] }[] = [];
  for (const entry of visibleEntries) {
    const label = dateGroupLabel(capturedOf(entry));
    const last = dateGroups[dateGroups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else dateGroups.push({ label, entries: [entry] });
  }

  // Folders view: Year -> Month -> Day, computed from capture date.
  const folderYears = new Map<number, Map<number, Map<number, ManifestEntry[]>>>();
  if (view === "folders") {
    for (const entry of libraryEntries) {
      const d = new Date(capturedOf(entry) * 1000);
      const y = d.getFullYear();
      const m = d.getMonth();
      const day = d.getDate();
      if (!folderYears.has(y)) folderYears.set(y, new Map());
      const months = folderYears.get(y)!;
      if (!months.has(m)) months.set(m, new Map());
      const days = months.get(m)!;
      if (!days.has(day)) days.set(day, []);
      days.get(day)!.push(entry);
    }
  }
  const folderYearsSorted = Array.from(folderYears.keys()).sort((a, b) => b - a);
  const folderMonths = folderPath.year !== undefined ? folderYears.get(folderPath.year) : undefined;
  const folderDays =
    folderPath.year !== undefined && folderPath.month !== undefined
      ? folderMonths?.get(folderPath.month)
      : undefined;
  const folderDayEntries =
    folderPath.year !== undefined && folderPath.month !== undefined && folderPath.day !== undefined
      ? (folderDays?.get(folderPath.day) ?? []).sort((a, b) => capturedOf(b) - capturedOf(a))
      : undefined;
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const selectedCount = Object.keys(selectedIds).length;
  const gridEntries = view === "folders" ? (folderDayEntries ?? []) : visibleEntries;
  const selecting = selectMode || selectedCount > 0;
  const allGridSelected = gridEntries.length > 0 && gridEntries.every((e) => selectedIds[e.file_id_hex]);
  const gridColumns = isMobile
    ? `repeat(${mobileCols}, 1fr)`
    : `repeat(auto-fill, minmax(${ZOOM_PX[zoom]}px, 1fr))`;


  function flashNotice(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice((cur) => (cur === msg ? "" : cur)), 2200);
  }

  function setTileLoading(id: string, loading: boolean) {
    setLoadingIds((prev) => {
      const next = new Set(prev);
      if (loading) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleUnlock() {
    setError("");
    setBusy(true);
    setStatus("Fetching config + manifest...");
    try {
      const [configRes, manifestRes] = await Promise.all([
        fetch("/api/config"),
        fetch("/api/manifest"),
      ]);
      if (!configRes.ok || !manifestRes.ok) {
        throw new Error("failed to fetch config/manifest from API routes");
      }
      const config: VaultConfig = await configRes.json();
      const manifestBuf = new Uint8Array(await manifestRes.arrayBuffer());

      setStatus("Deriving master key with Argon2id (this takes a moment)...");
      const masterKey = await deriveMasterKey(
        passphrase,
        config.salt_hex,
        config.time_cost,
        config.memory_cost_kib,
        config.parallelism
      );

      setStatus("Deriving header/wrap subkeys (HKDF-Expand)...");
      const { headerKey, wrapKey } = await deriveSubkeys(masterKey);

      setStatus("Decrypting manifest...");
      const manifest = await decryptManifest(manifestBuf, headerKey);

      setUnlocked({ wrapKey, headerKey, manifest });
      setStatus(
        `Unlocked. ${Object.keys(manifest.entries).length} items loaded.`
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? `${e.message} (likely wrong passphrase, or AEAD tag verification failure)`
          : String(e)
      );
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function persistManifest(manifest: Manifest) {
    if (!unlocked) return;
    const manifestBlob = await encryptManifest(unlocked.headerKey, manifest);
    const res = await fetch("/api/manifest", { method: "POST", body: manifestBlob as BodyInit });
    if (!res.ok) throw new Error("failed to save manifest");
    setUnlocked((prev) => (prev ? { ...prev, manifest } : prev));
  }

  // Entries whose object came back 404 are only flagged here -- a 404 can
  // mean the file is genuinely gone, but it can just as easily mean the
  // pCloud account that holds it dropped out of PCLOUD_ACCOUNTS while the
  // file is still sitting there untouched. Silently auto-trashing on every
  // such 404 during ordinary browsing/thumbnailing is too destructive a
  // default, so this just tracks candidates for the user to review and
  // move to trash themselves via the "N item(s) missing" banner.
  const [missingIds, setMissingIds] = useState<Record<string, true>>({});
  function flagMissing(id: string) {
    setMissingIds((prev) => (prev[id] ? prev : { ...prev, [id]: true }));
  }

  async function handleCleanupMissing() {
    if (!unlocked) return;
    const ids = Object.keys(missingIds);
    if (ids.length === 0) return;
    const ok = await askConfirm({
      title: `Move ${ids.length} item${ids.length === 1 ? "" : "s"} to Trash?`,
      body: "Their encrypted files couldn't be found under any currently configured cloud storage account. Double-check your account config if this number looks too high.",
      confirmLabel: "Move to Trash",
    });
    if (!ok) return;
    const nextEntries = { ...unlocked.manifest.entries };
    let changed = false;
    for (const id of ids) {
      if (nextEntries[id] && !nextEntries[id].deleted) {
        nextEntries[id] = { ...nextEntries[id], deleted: true };
        changed = true;
      }
    }
    setMissingIds({});
    if (!changed) return;
    try {
      await persistManifest({ ...unlocked.manifest, updated_ts: Date.now() / 1000, entries: nextEntries });
      setNotice(`Moved ${ids.length} item(s) to trash.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Central fetch for the encrypted object bytes. A confirmed 404 flags
  // the entry as a missing-object candidate (see above) instead of
  // silently trashing it.
  async function fetchObjectBytes(entry: ManifestEntry): Promise<Uint8Array> {
    const res = await fetch(`/api/object/${entry.file_id_hex}${accountQs(entry)}`);
    if (res.status === 404) {
      flagMissing(entry.file_id_hex);
      throw new Error("object not found in cloud storage");
    }
    if (!res.ok) throw new Error("failed to fetch object");
    return new Uint8Array(await res.arrayBuffer());
  }

  async function handleOpen(entry: ManifestEntry) {
    if (!unlocked) return;
    setError("");
    setTileLoading(entry.file_id_hex, true);

    // Show the lightbox immediately with whatever we already have (the
    // small cached thumbnail) instead of leaving the user staring at
    // nothing until the full decrypt/transcode finishes.
    openIdRef.current = entry.file_id_hex;
    setOpen((prev) => {
      // Prev/next swaps the open item without going through closeLightbox,
      // so release the previous full-size blob here or every swipe leaks one.
      if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
      return {
      entry,
      objectUrl: null,
      mime: entry.mime_type,
      note: "",
      downloadBlob: null,
      loading: true,
      placeholderUrl: thumbs[entry.file_id_hex] ?? null,
      };
    });

    // Later updates only apply if this is still the open item -- guards
    // against a stale async result landing after the user has already
    // navigated to a different one (e.g. rapid prev/next).
    const patchOpen = (patch: Partial<OpenState>) => {
      if (openIdRef.current !== entry.file_id_hex) {
        if (patch.objectUrl) URL.revokeObjectURL(patch.objectUrl);
        return;
      }
      setOpen((prev) =>
        prev && prev.entry.file_id_hex === entry.file_id_hex ? { ...prev, ...patch } : prev
      );
    };

    try {
      const buf = await fetchObjectBytes(entry);

      const fileKey = await unwrapFileKey(
        unlocked.wrapKey,
        entry.wrap_nonce_hex,
        entry.wrapped_key_hex,
        entry.file_id_hex
      );

      const { metadata, plaintext } = await decryptPvltObject(
        buf,
        fileKey,
        entry.file_id_hex
      );

      const isHeic = isHeicEntry(metadata.mime_type, metadata.filename);
      const isMov =
        metadata.mime_type.includes("quicktime") ||
        metadata.filename.toLowerCase().endsWith(".mov");

      const rawBlob = new Blob([plaintext as BlobPart], {
        type: isHeic ? "image/heic" : metadata.mime_type,
      });

      // Opening a photo already paid for the full download + decode, so if
      // its tile has no thumbnail yet, make one from it now (and store it)
      // rather than leaving the grid to regenerate it from scratch.
      const backfillThumb = (source: Blob) => {
        if (thumbs[entry.file_id_hex]) return;
        makeImageThumbnail(source)
          .then((t) => {
            showThumb(entry.file_id_hex, t);
            void storeThumb(entry, fileKey, t);
          })
          .catch(() => {});
      };

      if (isHeic && (await canDecodeNatively(rawBlob))) {
        backfillThumb(rawBlob);
        // Safari (iOS 17+ / macOS 14+) shows HEIC as-is -- no conversion,
        // no extra full-size JPEG copy in memory.
        patchOpen({
          objectUrl: URL.createObjectURL(rawBlob),
          mime: "image/heic",
          note: "",
          downloadBlob: rawBlob,
          loading: false,
        });
      } else if (isHeic) {
        try {
          const jpegBlob = await clientDecodeLimiter(() => convertHeicToJpeg(rawBlob));
          backfillThumb(jpegBlob);
          patchOpen({
            objectUrl: URL.createObjectURL(jpegBlob),
            mime: "image/jpeg",
            note: "Converted from HEIC to JPEG entirely in your browser for preview. Download gets you the original HEIC bytes.",
            downloadBlob: rawBlob,
            loading: false,
          });
        } catch (decodeErr) {
          patchOpen({
            objectUrl: null,
            mime: metadata.mime_type,
            note: `Decrypted successfully, but this HEIC/HEIF variant couldn't be decoded for preview in-browser: ${
              decodeErr instanceof Error ? decodeErr.message : String(decodeErr)
            }. You can still download the original file.`,
            downloadBlob: rawBlob,
            loading: false,
          });
        }
      } else if (isMov) {
        try {
          let mp4Blob = await getCachedVideo(entry.file_id_hex);
          if (!mp4Blob) {
            setStatus(`Transcoding ${entry.filename} for playback...`);
            const transcodeRes = await fetch("/api/transcode", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                file_id_hex: entry.file_id_hex,
                file_key_hex: bytesToHex(fileKey),
                account: entry.extra?.pcloud_account,
              }),
            });
            if (!transcodeRes.ok) {
              const body = await transcodeRes.json().catch(() => null);
              throw new Error(body?.error ?? "transcode failed");
            }
            mp4Blob = await transcodeRes.blob();
            await putCachedVideo(entry.file_id_hex, mp4Blob);
          }
          patchOpen({
            objectUrl: URL.createObjectURL(mp4Blob),
            mime: "video/mp4",
            note: "Transcoded from HEVC/.mov to H.264 for in-browser playback. Download gets the original file.",
            downloadBlob: rawBlob,
            loading: false,
          });
        } catch (transcodeErr) {
          patchOpen({
            objectUrl: URL.createObjectURL(rawBlob),
            mime: metadata.mime_type,
            note: `Transcoding failed (${
              transcodeErr instanceof Error ? transcodeErr.message : String(transcodeErr)
            }); some browsers can't play H.264/HEVC .mov via <video> (Safari usually can). If playback fails, download the file instead.`,
            downloadBlob: rawBlob,
            loading: false,
          });
        }
      } else {
        if (metadata.mime_type.startsWith("image/")) backfillThumb(rawBlob);
        patchOpen({
          objectUrl: URL.createObjectURL(rawBlob),
          mime: metadata.mime_type,
          note: "",
          downloadBlob: rawBlob,
          loading: false,
        });
      }

      setStatus(`Decrypted ${entry.filename} (${plaintext.length} bytes).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      patchOpen({ loading: false, note: "Failed to load this file -- see the error above." });
    } finally {
      setTileLoading(entry.file_id_hex, false);
    }
  }

  async function loadThumbnailClientSide(entry: ManifestEntry): Promise<Blob> {
    return clientDecodeLimiter(async () => {
      let sourceBlob: Blob;
      {
        // Scoped so the ciphertext/plaintext buffers can be collected as
        // soon as the source blob exists.
        const buf = await fetchObjectBytes(entry);
        const fileKey = await unwrapFileKey(
          unlocked!.wrapKey,
          entry.wrap_nonce_hex,
          entry.wrapped_key_hex,
          entry.file_id_hex
        );
        const { metadata, plaintext } = await decryptPvltObject(buf, fileKey, entry.file_id_hex);
        const mime = isHeicEntry(metadata.mime_type, metadata.filename)
          ? "image/heic"
          : metadata.mime_type;
        sourceBlob = new Blob([plaintext as BlobPart], { type: mime });
      }
      if (sourceBlob.type === "image/heic") {
        // Safari (every iPhone this targets) decodes HEIC natively via
        // createImageBitmap -- far cheaper than the WASM decoder.
        try {
          return await makeImageThumbnail(sourceBlob);
        } catch {
          sourceBlob = await convertHeicToJpeg(sourceBlob);
        }
      }
      return makeImageThumbnail(sourceBlob);
    });
  }

  // Tiles report when they come near / leave the viewport. Only tiles that
  // are (still) near when their turn in the queue comes up get processed;
  // the rest are dropped and re-requested if they scroll back into range.
  const nearIds = useRef<Set<string>>(new Set());
  const tileEls = useRef<Map<string, Element>>(new Map());
  function handleTileNear(entry: ManifestEntry, near: boolean, el: Element) {
    if (near) {
      nearIds.current.add(entry.file_id_hex);
      tileEls.current.set(entry.file_id_hex, el);
      void loadThumbnail(entry);
    } else {
      nearIds.current.delete(entry.file_id_hex);
      tileEls.current.delete(entry.file_id_hex);
    }
  }

  function showThumb(id: string, blob: Blob) {
    thumbsRequested.current.add(id);
    setThumbs((prev) => {
      if (prev[id]) URL.revokeObjectURL(prev[id]);
      return { ...prev, [id]: URL.createObjectURL(blob) };
    });
    void putCachedThumb(id, blob);
  }

  async function generateThumb(entry: ManifestEntry, fileKey: Uint8Array): Promise<Blob | null> {
    const isVideo = entry.mime_type.includes("quicktime") || entry.mime_type.startsWith("video/");
    // HEIC can't be decoded server-side here (no libheif in ffmpeg-static
    // or sharp's build) -- skip straight to the client-side decoder
    // instead of wasting a round trip that's guaranteed to 422.
    if (isHeicEntry(entry.mime_type, entry.filename)) return loadThumbnailClientSide(entry);
    try {
      const res = await fetch("/api/thumbnail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_id_hex: entry.file_id_hex,
          file_key_hex: bytesToHex(fileKey),
          account: entry.extra?.pcloud_account,
          is_video: isVideo,
        }),
        signal: AbortSignal.timeout(SERVER_THUMB_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error("server thumbnail failed");
      return await res.blob();
    } catch {
      if (isVideo) return null; // no client-side fallback for video posters
      return loadThumbnailClientSide(entry);
    }
  }

  // Order: this device's IndexedDB cache -> stored encrypted thumbnail ->
  // generate one (then store it for next time). Each queued step first
  // checks the tile is still near the viewport; if it was scrolled away
  // it's dropped and re-requested when it comes back into range.
  async function loadThumbnail(entry: ManifestEntry) {
    if (!unlocked) return;
    const id = entry.file_id_hex;
    if (thumbsRequested.current.has(id)) return;
    thumbsRequested.current.add(id);
    const isVideo = entry.mime_type.includes("quicktime") || entry.mime_type.startsWith("video/");
    let settled = false;
    const priority = () => {
      const el = tileEls.current.get(id);
      return el ? tilePriority(el) : Infinity;
    };
    try {
      const cached = await getCachedThumb(id);
      if (cached) {
        settled = true;
        showThumb(id, cached);
        return;
      }

      const fileKey = await unwrapFileKey(unlocked.wrapKey, entry.wrap_nonce_hex, entry.wrapped_key_hex, id);

      const stored = await storedThumbLimiter(
        async () => (nearIds.current.has(id) ? fetchStoredThumb(entry, fileKey) : undefined),
        priority
      );
      if (stored === undefined) return;
      if (stored) {
        settled = true;
        showThumb(id, stored);
        return;
      }

      const generated = await (isVideo ? videoThumbLimiter : photoThumbLimiter)(
        async () => (nearIds.current.has(id) ? generateThumb(entry, fileKey) : undefined),
        priority
      );
      if (generated === undefined) return;
      settled = true;
      if (!generated) return;
      showThumb(id, generated);
      void storeThumb(entry, fileKey, generated);
    } catch {
      // Thumbnail is best-effort; leave the icon placeholder on failure.
      settled = true;
    } finally {
      if (!settled) thumbsRequested.current.delete(id);
    }
  }

  function handleDownload() {
    if (!open?.downloadBlob) return;
    saveBlob(open.downloadBlob, open.entry.filename);
  }

  function closeLightbox() {
    if (open?.objectUrl) URL.revokeObjectURL(open.objectUrl);
    openIdRef.current = null;
    setOpen(null);
  }

  function openByOffset(offset: number) {
    if (!open) return;
    const idx = gridEntries.findIndex((e) => e.file_id_hex === open.entry.file_id_hex);
    if (idx === -1) return;
    const nextIdx = idx + offset;
    if (nextIdx < 0 || nextIdx >= gridEntries.length) return;
    handleOpen(gridEntries[nextIdx]);
  }

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0 || !unlocked) return;
    setError("");
    setBusy(true);
    try {
      let manifest = unlocked.manifest;
      for (const file of Array.from(files)) {
        setStatus(`Reading ${file.name}...`);
        const plaintext = new Uint8Array(await file.arrayBuffer());

        const fileIdBytes = new Uint8Array(16);
        crypto.getRandomValues(fileIdBytes);
        const fileIdHex = bytesToHex(fileIdBytes);

        const fileKey = new Uint8Array(32);
        crypto.getRandomValues(fileKey);

        const mimeType =
          file.type ||
          (file.name.toLowerCase().endsWith(".heic")
            ? "image/heic"
            : file.name.toLowerCase().endsWith(".mov")
            ? "video/quicktime"
            : "application/octet-stream");

        const capturedTs = await extractCapturedTs(plaintext);

        setStatus(`Encrypting ${file.name}...`);
        const encrypted = await encryptPvltObject(plaintext, fileKey, fileIdHex, {
          filename: file.name,
          mime_type: mimeType,
          created_ts: Date.now() / 1000,
        });

        const { wrap_nonce_hex, wrapped_key_hex } = await wrapFileKey(
          unlocked.wrapKey,
          fileIdHex,
          fileKey
        );

        setStatus(`Uploading ${file.name}...`);
        const uploadRes = await fetch(
          `/api/upload?fileId=${fileIdHex}&filename=${encodeURIComponent(fileIdHex + ".pvlt")}`,
          { method: "POST", body: encrypted as BodyInit }
        );
        if (!uploadRes.ok) throw new Error(`upload failed for ${file.name}`);
        const { account } = (await uploadRes.json()) as { account: string };

        const entry: ManifestEntry = {
          file_id_hex: fileIdHex,
          wrap_nonce_hex,
          wrapped_key_hex,
          object_path: `objects/${fileIdHex}.pvlt`,
          filename: file.name,
          mime_type: mimeType,
          size: plaintext.length,
          added_ts: Date.now() / 1000,
          ...(capturedTs !== null ? { captured_ts: capturedTs } : {}),
          deleted: false,
          extra: { pcloud_account: account },
        };

        manifest = {
          ...manifest,
          updated_ts: Date.now() / 1000,
          entries: { ...manifest.entries, [fileIdHex]: entry },
        };

        setStatus(`Saving manifest for ${file.name}...`);
        await persistManifest(manifest);
        setStatus(`Uploaded ${file.name} to ${account}.`);
      }
      setStatus(`Upload complete.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ---- Selection ----
  function toggleSelect(id: string) {
    setSelectionAnchor(id);
    setSelectedIds((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds({});
    setSelectMode(false);
    setSelectionAnchor(null);
  }
  // Shift-click: select everything between the last clicked tile and this
  // one (in on-screen order), keeping whatever was already selected.
  function selectRangeTo(id: string) {
    const anchor = selectionAnchor;
    const order = gridEntries.map((e) => e.file_id_hex);
    const i = anchor ? order.indexOf(anchor) : -1;
    const j = order.indexOf(id);
    if (i === -1 || j === -1) return toggleSelect(id);
    setSelectedIds((prev) => {
      const next = { ...prev };
      for (let k = Math.min(i, j); k <= Math.max(i, j); k++) next[order[k]] = true;
      return next;
    });
  }
  function toggleGroup(entries: ManifestEntry[]) {
    const all = entries.every((e) => selectedIds[e.file_id_hex]);
    setSelectedIds((prev) => {
      const next = { ...prev };
      for (const e of entries) {
        if (all) delete next[e.file_id_hex];
        else next[e.file_id_hex] = true;
      }
      return next;
    });
  }
  function handleTileClick(entry: ManifestEntry, e: React.MouseEvent) {
    if (e.shiftKey && selectionAnchor) selectRangeTo(entry.file_id_hex);
    else if (e.metaKey || e.ctrlKey || selecting) toggleSelect(entry.file_id_hex);
    else handleOpen(entry);
  }
  function handleCheckClick(entry: ManifestEntry, e: React.MouseEvent) {
    if (e.shiftKey && selectionAnchor) selectRangeTo(entry.file_id_hex);
    else toggleSelect(entry.file_id_hex);
  }
  function selectAllVisible(entries: ManifestEntry[]) {
    const next: Record<string, boolean> = {};
    for (const e of entries) next[e.file_id_hex] = true;
    setSelectedIds(next);
  }

  async function decryptEntryToBlob(entry: ManifestEntry): Promise<Blob> {
    const buf = await fetchObjectBytes(entry);
    const fileKey = await unwrapFileKey(
      unlocked!.wrapKey,
      entry.wrap_nonce_hex,
      entry.wrapped_key_hex,
      entry.file_id_hex
    );
    const { metadata, plaintext } = await decryptPvltObject(buf, fileKey, entry.file_id_hex);
    return new Blob([plaintext as BlobPart], { type: metadata.mime_type });
  }

  async function handleBulkDownload() {
    if (!unlocked) return;
    const ids = Object.keys(selectedIds);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      for (const id of ids) {
        const entry = unlocked.manifest.entries[id];
        if (!entry) continue;
        setStatus(`Downloading ${entry.filename}...`);
        saveBlob(await decryptEntryToBlob(entry), entry.filename);
      }
      setStatus(`Downloaded ${ids.length} item(s).`);
      clearSelection();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleBulkDelete() {
    if (!unlocked) return;
    const ids = Object.keys(selectedIds);
    if (ids.length === 0) return;
    setBusy(true);
    setStatus(`Moving ${ids.length} item(s) to trash...`);
    try {
      const nextEntries = { ...unlocked.manifest.entries };
      for (const id of ids) {
        if (nextEntries[id]) nextEntries[id] = { ...nextEntries[id], deleted: true };
      }
      await persistManifest({ ...unlocked.manifest, updated_ts: Date.now() / 1000, entries: nextEntries });
      setStatus(`Moved ${ids.length} item(s) to trash.`);
      clearSelection();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore(id: string) {
    if (!unlocked) return;
    const entry = unlocked.manifest.entries[id];
    if (!entry) return;
    const nextEntries = { ...unlocked.manifest.entries, [id]: { ...entry, deleted: false } };
    await persistManifest({ ...unlocked.manifest, entries: nextEntries });
  }

  async function handleBulkRestore() {
    if (!unlocked) return;
    const ids = Object.keys(selectedIds);
    if (ids.length === 0) return;
    const nextEntries = { ...unlocked.manifest.entries };
    for (const id of ids) {
      if (nextEntries[id]) nextEntries[id] = { ...nextEntries[id], deleted: false };
    }
    await persistManifest({ ...unlocked.manifest, updated_ts: Date.now() / 1000, entries: nextEntries });
    clearSelection();
  }

  // Deletes the encrypted blobs from cloud storage (a few at a time) and
  // then drops the entries from the manifest in one save.
  async function deletePermanently(ids: string[]) {
    if (!unlocked || ids.length === 0) return;
    setBusy(true);
    const progress = { done: 0 };
    setStatus(`Deleting 0 / ${ids.length} from cloud storage...`);
    try {
      const failures: string[] = [];
      await Promise.all(
        ids.map((id) =>
          cloudDeleteLimiter(async () => {
            const entry = unlocked.manifest.entries[id];
            if (!entry) return;
            try {
              const res = await fetch(`/api/object/${entry.file_id_hex}${accountQs(entry)}`, { method: "DELETE" });
              if (!res.ok) failures.push(entry.filename);
            } catch {
              failures.push(entry.filename);
            }
            progress.done++;
            setStatus(`Deleting ${progress.done} / ${ids.length} from cloud storage...`);
          })
        )
      );

      const nextEntries = { ...unlocked.manifest.entries };
      for (const id of ids) delete nextEntries[id];
      await persistManifest({ ...unlocked.manifest, updated_ts: nowSec(), entries: nextEntries });
      clearSelection();
      setStatus(
        failures.length
          ? `Removed ${ids.length} item(s); cloud delete failed for ${failures.length}: ${failures.join(", ")}.`
          : `Permanently deleted ${ids.length} item(s) from cloud storage.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleBulkDeletePermanently() {
    const ids = Object.keys(selectedIds);
    if (ids.length === 0) return;
    const ok = await askConfirm({
      title: `Delete ${ids.length} item${ids.length === 1 ? "" : "s"} forever?`,
      body: "This also deletes the encrypted files from cloud storage. It can't be undone.",
      confirmLabel: "Delete forever",
      danger: true,
    });
    if (ok) await deletePermanently(ids);
  }

  async function handleEmptyTrash() {
    const ids = trashEntries.map((e) => e.file_id_hex);
    if (ids.length === 0) return;
    const ok = await askConfirm({
      title: "Empty Trash?",
      body: `All ${ids.length} item${ids.length === 1 ? "" : "s"} in Trash will be permanently deleted from cloud storage. This can't be undone.`,
      confirmLabel: `Delete ${ids.length} forever`,
      danger: true,
    });
    if (ok) await deletePermanently(ids);
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") openByOffset(-1);
      else if (e.key === "ArrowRight") openByOffset(1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.entry.file_id_hex]);

  const touchStartX = useRef<number | null>(null);

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    const SWIPE_THRESHOLD = 50;
    if (dx > SWIPE_THRESHOLD) openByOffset(-1);
    else if (dx < -SWIPE_THRESHOLD) openByOffset(1);
  }

  function zoomBy(dir: 1 | -1) {
    if (isMobile) {
      setMobileCols((c) => Math.min(6, Math.max(2, c - dir)));
    } else {
      const order: Zoom[] = ["S", "M", "L", "XL"];
      setZoom((z) => order[Math.min(3, Math.max(0, order.indexOf(z) + dir))]);
    }
  }

  useGridGestures({
    active: !!unlocked,
    hostRef: mainRef,
    marqueeClass: styles.marquee,
    getOrder: () => gridEntries.map((e) => e.file_id_hex),
    getSelected: () => selectedIds,
    setSelected: setSelectedIds,
    onLongPress: () => setSelectMode(true),
    onZoom: zoomBy,
    enabled: () => !open && !confirmState,
  });

  // Esc clears the selection, Cmd/Ctrl+A selects everything in the grid.
  useEffect(() => {
    if (!unlocked || open || confirmState) return;
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea")) return;
      if (e.key === "Escape" && selecting) clearSelection();
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && gridEntries.length > 0) {
        e.preventDefault();
        selectAllVisible(gridEntries);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div
      className={styles.page}
      data-theme={theme}
      onDragOver={(e) => unlocked && e.preventDefault()}
      onDrop={(e) => {
        if (!unlocked) return;
        e.preventDefault();
        handleUpload(e.dataTransfer.files);
      }}
    >
      {!unlocked ? (
        <main className={styles.unlockMain}>
          <div className={styles.unlockCard}>
            <h1>Vault</h1>
            <p>
              Every key derivation and file decryption happens locally in
              your browser. Your passphrase never leaves this device.
            </p>
            <input
              className={styles.input}
              type="password"
              placeholder="Passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && passphrase && handleUnlock()}
              disabled={busy}
            />
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={handleUnlock}
              disabled={busy || !passphrase}
            >
              {busy ? "Unlocking..." : "Unlock"}
            </button>
            {status && (
              <div className={styles.statusBar}>
                {busy && <span className={styles.spinner} />}
                {status}
              </div>
            )}
            {error && <div className={styles.errorBar}>{error}</div>}
          </div>
        </main>
      ) : (
        <div className={styles.shell}>
          {/* ===== Desktop sidebar ===== */}
          {!isMobile && (
            <div className={styles.sidebar}>
              <div className={styles.sidebarBrand}>
                <span className={styles.lockIcon}>🔒</span>
                <span className={styles.brandName}>Vault</span>
              </div>

              <div className={styles.searchBox}>
                <span className={styles.searchIcon}>⌕</span>
                <input
                  className={styles.searchInput}
                  placeholder="Search your library"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              <nav className={styles.navList}>
                {(
                  [
                    ["library", libraryEntries.length],
                    ["photos", photoEntries.length],
                    ["videos", videoEntries.length],
                  ] as const
                ).map(([v, count]) => (
                  <button
                    key={v}
                    className={`${styles.navItem} ${view === v ? styles.navItemActive : ""}`}
                    onClick={() => changeView(v)}
                  >
                    <span className={styles.navIcon}><Icon name={v} size={16} /></span>
                    <span>{VIEW_TITLES[v]}</span>
                    <span className={styles.navCount}>{count}</span>
                  </button>
                ))}
                <button
                  className={styles.navItem}
                  disabled
                  title="Albums aren't implemented yet -- see FEATURES.md"
                >
                  <span className={styles.navIcon}><Icon name="library" size={16} /></span>
                  <span>Albums</span>
                </button>
                <button
                  className={`${styles.navItem} ${view === "trash" ? styles.navItemActive : ""}`}
                  onClick={() => changeView("trash")}
                >
                  <span className={styles.navIcon}><Icon name="trash" size={16} /></span>
                  <span>Trash</span>
                  {trashEntries.length > 0 && (
                    <span className={styles.navCount}>{trashEntries.length}</span>
                  )}
                </button>
              </nav>

              <div className={styles.foldersSection}>
                <div className={styles.foldersHeading}>Folders</div>
                <button
                  className={`${styles.folderRow} ${view === "folders" ? styles.navItemActive : ""}`}
                  onClick={() => changeView("folders")}
                >
                  <span className={styles.navIcon}><Icon name="folders" size={16} /></span>
                  <span>By date</span>
                </button>
              </div>

              <div style={{ flex: 1 }} />

              <div className={styles.storageCard}>
                <div className={styles.storageCardTop}>
                  <span>Vault storage</span>
                  <span className={styles.mono}>
                    {storage ? `${formatBytes(storage.used)} / ${formatBytes(storage.quota)}` : "..."}
                  </span>
                </div>
                <div className={styles.meterTrack}>
                  <div
                    className={styles.meterFill}
                    style={{
                      width: storage && storage.quota > 0
                        ? `${Math.min(100, (storage.used / storage.quota) * 100)}%`
                        : "0%",
                    }}
                  />
                </div>
                <div className={styles.storageCardFoot}>
                  {storage
                    ? storage.grandQuota > storage.quota
                      ? `${formatBytes(storage.grandUsed)} / ${formatBytes(storage.grandQuota)} combined across all backup storage`
                      : "Across all configured accounts"
                    : "Loading usage..."}
                </div>
              </div>

              <div className={styles.userRow}>
                <div className={styles.avatar} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className={styles.userName}>You</div>
                  <div className={styles.userSub}>End-to-end encrypted</div>
                </div>
                <button
                  className={styles.themeToggle}
                  onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                >
                  {theme === "dark" ? "Light" : "Dark"}
                </button>
              </div>
            </div>
          )}

          {/* ===== Mobile header (swaps to a selection header while selecting) ===== */}
          {isMobile && (selecting ? (
            <div className={`${styles.mobileHeader} ${styles.mobileHeaderSelecting}`}>
              <div className={styles.mobileHeaderLeft}>
                <button className={styles.iconBtnGhost} onClick={clearSelection} aria-label="Cancel selection">
                  <Icon name="close" />
                </button>
                <span className={styles.selectionTitle}>
                  {selectedCount === 0 ? "Select items" : `${selectedCount} selected`}
                </span>
              </div>
              {gridEntries.length > 0 && (
                <button
                  className={styles.headerTextBtn}
                  onClick={() => (allGridSelected ? setSelectedIds({}) : selectAllVisible(gridEntries))}
                >
                  {allGridSelected ? "Deselect all" : "Select all"}
                </button>
              )}
            </div>
          ) : (
            <div className={styles.mobileHeader}>
              <div className={styles.mobileHeaderLeft}>
                <span className={styles.lockIcon}>🔒</span>
                <span className={styles.brandName}>Vault</span>
              </div>
              <div className={styles.mobileHeaderRight}>
                {view !== "trash" && view !== "folders" && (
                  <button
                    className={`${styles.iconBtn} ${styles.iconBtnAccent}`}
                    disabled={busy}
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="Upload"
                  >
                    {busy ? <span className={styles.spinner} /> : <Icon name="upload" />}
                  </button>
                )}
                <button
                  className={styles.iconBtn}
                  onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                  aria-label="Toggle theme"
                >
                  <Icon name={theme === "dark" ? "sun" : "moon"} />
                </button>
              </div>
            </div>
          ))}

          {/* ===== Main ===== */}
          <div className={styles.main} ref={mainRef}>
            <div className={styles.toolbar}>
              <div className={styles.toolbarTitleBlock}>
                <div className={styles.title}>{VIEW_TITLES[view]}</div>
                {view === "folders" ? (
                  <div className={styles.folderCrumbs}>
                    <button className={styles.folderCrumb} onClick={() => setFolderPath({})}>
                      Folders
                    </button>
                    {folderPath.year !== undefined && (
                      <>
                        <span className={styles.folderCrumbSep}>/</span>
                        <button
                          className={styles.folderCrumb}
                          onClick={() => setFolderPath({ year: folderPath.year })}
                        >
                          {folderPath.year}
                        </button>
                      </>
                    )}
                    {folderPath.month !== undefined && (
                      <>
                        <span className={styles.folderCrumbSep}>/</span>
                        <button
                          className={styles.folderCrumb}
                          onClick={() => setFolderPath({ year: folderPath.year, month: folderPath.month })}
                        >
                          {MONTH_NAMES[folderPath.month]}
                        </button>
                      </>
                    )}
                    {folderPath.day !== undefined && (
                      <>
                        <span className={styles.folderCrumbSep}>/</span>
                        <span>{folderPath.day}</span>
                      </>
                    )}
                  </div>
                ) : (
                  <div className={styles.subtitle}>
                    {visibleEntries.length} {view === "photos" ? "photo" : view === "videos" ? "video" : "item"}
                    {visibleEntries.length === 1 ? "" : "s"} · fully encrypted
                  </div>
                )}
              </div>
              <div className={styles.toolbarActions}>
                {isMobile ? (
                  !selecting && (
                    <>
                      {view === "trash" && trashEntries.length > 0 && (
                        <button className={styles.pillBtnDanger} onClick={handleEmptyTrash} disabled={busy}>
                          Empty Trash
                        </button>
                      )}
                      {gridEntries.length > 0 && (
                        <button className={styles.pillBtn} onClick={() => setSelectMode(true)}>
                          Select
                        </button>
                      )}
                    </>
                  )
                ) : (
                  <>
                    {gridEntries.length > 0 && (
                      <button
                        className={styles.textBtn}
                        onClick={() => (allGridSelected ? clearSelection() : selectAllVisible(gridEntries))}
                        title="⌘A / Ctrl+A"
                      >
                        {allGridSelected ? "Select none" : "Select all"}
                      </button>
                    )}
                    {selecting && (
                      <button className={styles.textBtn} onClick={clearSelection} title="Esc">
                        Cancel
                      </button>
                    )}
                    {view === "trash" && trashEntries.length > 0 && (
                      <button className={`${styles.btn} ${styles.btnDanger}`} onClick={handleEmptyTrash} disabled={busy}>
                        <Icon name="trash" size={16} /> Empty Trash
                      </button>
                    )}
                    {gridEntries.length > 0 ? (
                      <div className={styles.zoomGroup} title="Tip: pinch or Ctrl+scroll on the grid to zoom">
                        {(["S", "M", "L", "XL"] as Zoom[]).map((z) => (
                          <button
                            key={z}
                            className={`${styles.zoomBtn} ${zoom === z ? styles.zoomBtnActive : ""}`}
                            onClick={() => setZoom(z)}
                          >
                            {z}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {view !== "trash" && view !== "folders" && (
                      <button
                        className={`${styles.btn} ${styles.btnPrimary}`}
                        disabled={busy}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {busy ? "Uploading..." : "↑ Upload"}
                      </button>
                    )}
                  </>
                )}
                <input
                  ref={fileInputRef}
                  className={styles.fileInput}
                  id="upload-input"
                  type="file"
                  multiple
                  accept="image/*,video/*,.heic,.mov"
                  disabled={busy}
                  onChange={(e) => handleUpload(e.target.files)}
                />
              </div>
            </div>

            {isMobile && (
              <div className={styles.mobileSearchBox}>
                <span className={styles.searchIcon}>⌕</span>
                <input
                  className={styles.searchInput}
                  placeholder="Search your library"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            )}

            {(status || error || notice) && (
              <div className={styles.statusRow}>
                {status && !error && (
                  <div className={styles.statusBar}>
                    {busy && <span className={styles.spinner} />}
                    {status}
                  </div>
                )}
                {notice && !error && <div className={styles.statusBar}>{notice}</div>}
                {error && <div className={styles.errorBar}>{error}</div>}
              </div>
            )}

            {Object.keys(missingIds).length > 0 && (
              <div className={styles.statusRow}>
                <div className={styles.errorBar}>
                  {Object.keys(missingIds).length} item(s) couldn&apos;t be found under any currently
                  configured cloud storage account. If this looks like a lot, check your storage account
                  config before cleaning up -- the files may still exist under an account that dropped out
                  of config, not actually be deleted.
                  <button className={styles.textBtn} onClick={handleCleanupMissing} style={{ marginLeft: 8 }}>
                    Move to trash
                  </button>
                  <button
                    className={styles.textBtn}
                    onClick={() => setMissingIds({})}
                    style={{ marginLeft: 4 }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {view === "folders" && folderPath.year === undefined ? (
              folderYearsSorted.length === 0 ? (
                <div className={styles.emptyState}>No items yet. Upload a photo or video to get started.</div>
              ) : (
                <div className={`${styles.gridScroll} om-scroll`} data-scroll-root data-selecting={selecting}>
                  <div className={styles.folderGrid}>
                    {folderYearsSorted.map((y) => {
                      const count = Array.from(folderYears.get(y)!.values()).reduce(
                        (sum, days) => sum + Array.from(days.values()).reduce((s, e) => s + e.length, 0),
                        0
                      );
                      return (
                        <button
                          key={y}
                          className={styles.folderCard}
                          onClick={() => setFolderPath({ year: y })}
                        >
                          <span className={styles.folderCardIcon}>📁</span>
                          <span className={styles.folderCardLabel}>{y}</span>
                          <span className={styles.folderCardCount}>
                            {count} item{count === 1 ? "" : "s"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )
            ) : view === "folders" && folderPath.month === undefined ? (
              <div className={`${styles.gridScroll} om-scroll`} data-scroll-root data-selecting={selecting}>
                <div className={styles.folderGrid}>
                  {MONTH_NAMES.map((name, m) => {
                    const days = folderMonths?.get(m);
                    const count = days
                      ? Array.from(days.values()).reduce((s, e) => s + e.length, 0)
                      : 0;
                    return (
                      <button
                        key={m}
                        className={styles.folderCard}
                        disabled={count === 0}
                        onClick={() => setFolderPath({ year: folderPath.year, month: m })}
                      >
                        <span className={styles.folderCardIcon}>📁</span>
                        <span className={styles.folderCardLabel}>{name}</span>
                        <span className={styles.folderCardCount}>
                          {count} item{count === 1 ? "" : "s"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : view === "folders" && folderPath.day === undefined ? (
              <div className={`${styles.gridScroll} om-scroll`} data-scroll-root data-selecting={selecting}>
                <div className={styles.folderGrid}>
                  {Array.from(folderDays?.keys() ?? [])
                    .sort((a, b) => a - b)
                    .map((day) => {
                      const count = folderDays!.get(day)!.length;
                      return (
                        <button
                          key={day}
                          className={styles.folderCard}
                          onClick={() => setFolderPath({ year: folderPath.year, month: folderPath.month, day })}
                        >
                          <span className={styles.folderCardIcon}>📁</span>
                          <span className={styles.folderCardLabel}>{day}</span>
                          <span className={styles.folderCardCount}>
                            {count} item{count === 1 ? "" : "s"}
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>
            ) : view === "folders" ? (
              (folderDayEntries ?? []).length === 0 ? (
                <div className={styles.emptyState}>No items on this day.</div>
              ) : (
                <div className={`${styles.gridScroll} om-scroll`} data-scroll-root data-selecting={selecting}>
                  <div
                    className={styles.grid}
                    style={{ gridTemplateColumns: gridColumns }}
                  >
                    {(folderDayEntries ?? []).map((entry) => (
                      <Tile
                        key={entry.file_id_hex}
                        entry={entry}
                        thumbUrl={thumbs[entry.file_id_hex]}
                        selected={!!selectedIds[entry.file_id_hex]}
                        loading={loadingIds.has(entry.file_id_hex)}
                        onTileClick={handleTileClick}
                        onCheckClick={handleCheckClick}
                        onNearChange={handleTileNear}
                      />
                    ))}
                  </div>
                </div>
              )
            ) : visibleEntries.length === 0 ? (
              <div className={styles.emptyState}>
                {view === "trash"
                  ? "Trash is empty."
                  : searchLower
                  ? "No items match your search."
                  : "No items yet. Upload a photo or video to get started."}
              </div>
            ) : (
              <div className={`${styles.gridScroll} om-scroll`} data-scroll-root data-selecting={selecting}>
                {dateGroups.map((group) => (
                  <div key={group.label} className={styles.dateGroup}>
                    {(() => {
                      const groupAll = group.entries.every((e) => selectedIds[e.file_id_hex]);
                      return (
                        <button
                          className={styles.dateLabel}
                          data-all={groupAll}
                          onClick={() => toggleGroup(group.entries)}
                          title={groupAll ? "Deselect this day" : "Select this day"}
                        >
                          <span className={styles.dateCheck}>{groupAll && <Icon name="check" size={11} />}</span>
                          {group.label}
                          <span className={styles.dateCount}>{group.entries.length}</span>
                        </button>
                      );
                    })()}
                    <div
                      className={styles.grid}
                      style={{ gridTemplateColumns: gridColumns }}
                    >
                      {group.entries.map((entry) => (
                      <Tile
                        key={entry.file_id_hex}
                        entry={entry}
                        thumbUrl={thumbs[entry.file_id_hex]}
                        selected={!!selectedIds[entry.file_id_hex]}
                        loading={loadingIds.has(entry.file_id_hex)}
                        onTileClick={handleTileClick}
                        onCheckClick={handleCheckClick}
                        onNearChange={handleTileNear}
                      />
                    ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ===== Mobile bottom: tabs, or an action bar while selecting ===== */}
          {isMobile && (selecting ? (
            <div className={styles.bottomActions}>
              {view === "trash" ? (
                <>
                  <button className={styles.bottomAction} disabled={!selectedCount || busy} onClick={handleBulkRestore}>
                    <Icon name="restore" />
                    Restore
                  </button>
                  <button
                    className={`${styles.bottomAction} ${styles.bottomActionDanger}`}
                    disabled={!selectedCount || busy}
                    onClick={handleBulkDeletePermanently}
                  >
                    <Icon name="trash" />
                    Delete forever
                  </button>
                </>
              ) : (
                <>
                  <button className={styles.bottomAction} disabled={!selectedCount || busy} onClick={handleBulkDownload}>
                    <Icon name="download" />
                    Download
                  </button>
                  <button
                    className={`${styles.bottomAction} ${styles.bottomActionDanger}`}
                    disabled={!selectedCount || busy}
                    onClick={handleBulkDelete}
                  >
                    <Icon name="trash" />
                    Delete
                  </button>
                </>
              )}
            </div>
          ) : (
            <nav className={styles.bottomTabs}>
              {(["library", "photos", "videos", "folders", "trash"] as View[]).map((v) => (
                <button
                  key={v}
                  className={`${styles.bottomTab} ${view === v ? styles.bottomTabActive : ""}`}
                  onClick={() => changeView(v)}
                  aria-current={view === v ? "page" : undefined}
                >
                  <span className={styles.bottomTabIcon}>
                    <Icon name={v} size={22} />
                    {v === "trash" && trashEntries.length > 0 && (
                      <span className={styles.tabBadge}>{trashEntries.length > 99 ? "99+" : trashEntries.length}</span>
                    )}
                  </span>
                  {VIEW_TITLES[v]}
                </button>
              ))}
            </nav>
          ))}

          {/* ===== Floating selection bar (desktop) ===== */}
          {!isMobile && selectedCount > 0 && (
            <div className={styles.selectionBar}>
              <button className={styles.selectionClose} onClick={clearSelection} aria-label="Clear selection" title="Esc">
                <Icon name="close" size={14} />
              </button>
              <span className={styles.selectionCount}>{selectedCount} selected</span>
              <div className={styles.selectionDivider} />
              {view === "trash" ? (
                <>
                  <button className={styles.selectionAction} onClick={handleBulkRestore}>
                    Restore
                  </button>
                  <button className={styles.selectionActionDanger} onClick={handleBulkDeletePermanently}>
                    Delete permanently
                  </button>
                </>
              ) : (
                <>
                  <button className={styles.selectionAction} onClick={handleBulkDownload}>
                    Download
                  </button>
                  <button
                    className={styles.selectionAction}
                    style={{ opacity: 0.4, cursor: "not-allowed" }}
                    onClick={() => flashNotice("Share isn't implemented yet")}
                  >
                    Share
                  </button>
                  <button
                    className={styles.selectionAction}
                    style={{ opacity: 0.4, cursor: "not-allowed" }}
                    onClick={() => flashNotice("Move isn't implemented yet (no folders yet)")}
                  >
                    Move
                  </button>
                  <button className={styles.selectionActionDanger} onClick={handleBulkDelete}>
                    Delete
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {confirmState && (
        <div className={styles.confirmOverlay} onClick={() => settleConfirm(false)}>
          <div
            className={styles.confirmCard}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") settleConfirm(false);
            }}
          >
            <div className={styles.confirmTitle} id="confirm-title">{confirmState.title}</div>
            <div className={styles.confirmBody}>{confirmState.body}</div>
            <div className={styles.confirmActions}>
              <button className={styles.btn} onClick={() => settleConfirm(false)}>
                Cancel
              </button>
              <button
                autoFocus
                className={`${styles.btn} ${confirmState.danger ? styles.btnDangerSolid : styles.btnPrimary}`}
                onClick={() => settleConfirm(true)}
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {open && (() => {
        const idx = gridEntries.findIndex((e) => e.file_id_hex === open.entry.file_id_hex);
        const hasPrev = idx > 0;
        const hasNext = idx !== -1 && idx < gridEntries.length - 1;
        return (
          <div className={styles.lightboxOverlay} onClick={closeLightbox}>
            <div
              className={styles.lightbox}
              onClick={(e) => e.stopPropagation()}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            >
              <div className={styles.lightboxHeader}>
                <div className={styles.lightboxTitle}>
                  <span className={styles.lightboxFilename}>{open.entry.filename}</span>
                  {idx !== -1 && (
                    <span className={styles.lightboxCounter}>
                      {idx + 1} / {gridEntries.length}
                    </span>
                  )}
                </div>
                <div className={styles.lightboxActions}>
                  <button
                    className={styles.btn}
                    onClick={handleDownload}
                    disabled={!open.downloadBlob}
                    aria-label="Download"
                  >
                    <Icon name="download" size={16} />
                    <span className={styles.btnLabel}>Download</span>
                  </button>
                  {view === "trash" ? (
                    <button
                      className={styles.btn}
                      onClick={() => handleRestore(open.entry.file_id_hex)}
                      aria-label="Restore"
                    >
                      <Icon name="restore" size={16} />
                      <span className={styles.btnLabel}>Restore</span>
                    </button>
                  ) : null}
                  <button className={styles.btn} onClick={closeLightbox} aria-label="Close">
                    <Icon name="close" size={16} />
                    <span className={styles.btnLabel}>Close</span>
                  </button>
                </div>
              </div>
              {open.note && <div className={styles.lightboxNote}>{open.note}</div>}
              <div className={styles.lightboxBody}>
                {hasPrev && (
                  <button
                    className={`${styles.navBtn} ${styles.navBtnLeft}`}
                    onClick={() => openByOffset(-1)}
                    aria-label="Previous"
                  >
                    {"‹"}
                  </button>
                )}
                {open.objectUrl && open.mime.includes("quicktime") && (
                  <video src={open.objectUrl} controls autoPlay />
                )}
                {open.objectUrl &&
                  !open.mime.includes("quicktime") &&
                  (open.mime.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={open.objectUrl} alt={open.entry.filename} />
                  ) : (
                    <video src={open.objectUrl} controls autoPlay />
                  ))}
                {!open.objectUrl && open.placeholderUrl && (
                  // Blown-up cached thumbnail while the full-res decrypt (and
                  // transcode, for video) is still in flight, instead of a
                  // blank lightbox -- swaps out for the real media above as
                  // soon as it's ready.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={open.placeholderUrl}
                    alt={open.entry.filename}
                    className={styles.lightboxPlaceholderImg}
                  />
                )}
                {!open.objectUrl && open.loading && (
                  <div className={styles.lightboxLoadingOverlay}>
                    <span className={styles.spinner} />
                  </div>
                )}
                {!open.objectUrl && !open.loading && !open.placeholderUrl && (
                  <div className={styles.lightboxFallback}>
                    <div style={{ fontSize: 48 }}>{"\u{1F5BC}️"}</div>
                    <div>No preview available -- use Download to get the file.</div>
                  </div>
                )}
                {hasNext && (
                  <button
                    className={`${styles.navBtn} ${styles.navBtnRight}`}
                    onClick={() => openByOffset(1)}
                    aria-label="Next"
                  >
                    {"›"}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
