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
  bytesToHex,
  type VaultConfig,
  type Manifest,
  type ManifestEntry,
} from "@/lib/vaultCrypto";
import { convertHeicToJpeg } from "@/lib/heicConvert";
import { getCachedThumb, putCachedThumb } from "@/lib/thumbCache";
import { getCachedVideo, putCachedVideo } from "@/lib/videoCache";
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
type View = "library" | "trash";
type Theme = "dark" | "light";

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

export default function Home() {
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [unlocked, setUnlocked] = useState<UnlockedState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

  const [open, setOpen] = useState<OpenState | null>(null);
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
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [isMobile, setIsMobile] = useState(false);
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null);
  const [notice, setNotice] = useState<string>("");

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
    if (!unlocked) return;
    fetch("/api/storage")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && typeof j.quota === "number") setStorage({ used: j.usedquota, quota: j.quota });
      })
      .catch(() => {});
  }, [unlocked]);

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

  async function handleOpen(entry: ManifestEntry) {
    if (!unlocked) return;
    setError("");
    setTileLoading(entry.file_id_hex, true);

    // Show the lightbox immediately with whatever we already have (the
    // small cached thumbnail) instead of leaving the user staring at
    // nothing until the full decrypt/transcode finishes.
    setOpen({
      entry,
      objectUrl: null,
      mime: entry.mime_type,
      note: "",
      downloadBlob: null,
      loading: true,
      placeholderUrl: thumbs[entry.file_id_hex] ?? null,
    });

    // Later updates only apply if this is still the open item -- guards
    // against a stale async result landing after the user has already
    // navigated to a different one (e.g. rapid prev/next).
    const patchOpen = (patch: Partial<OpenState>) =>
      setOpen((prev) =>
        prev && prev.entry.file_id_hex === entry.file_id_hex ? { ...prev, ...patch } : prev
      );

    try {
      const accountQs = entry.extra?.pcloud_account
        ? `?account=${encodeURIComponent(String(entry.extra.pcloud_account))}`
        : "";
      const res = await fetch(`/api/object/${entry.file_id_hex}${accountQs}`);
      if (!res.ok) throw new Error("failed to fetch object");
      const buf = new Uint8Array(await res.arrayBuffer());

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

      const isHeic =
        metadata.mime_type.includes("heic") ||
        metadata.filename.toLowerCase().endsWith(".heic");
      const isMov =
        metadata.mime_type.includes("quicktime") ||
        metadata.filename.toLowerCase().endsWith(".mov");

      const rawBlob = new Blob([plaintext.buffer as ArrayBuffer], {
        type: metadata.mime_type,
      });

      if (isHeic) {
        try {
          const jpegBlob = await convertHeicToJpeg(plaintext);
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
    const accountQs = entry.extra?.pcloud_account
      ? `?account=${encodeURIComponent(String(entry.extra.pcloud_account))}`
      : "";
    const res = await fetch(`/api/object/${entry.file_id_hex}${accountQs}`);
    if (!res.ok) throw new Error("failed to fetch object");
    const buf = new Uint8Array(await res.arrayBuffer());
    const fileKey = await unwrapFileKey(
      unlocked!.wrapKey,
      entry.wrap_nonce_hex,
      entry.wrapped_key_hex,
      entry.file_id_hex
    );
    const { metadata, plaintext } = await decryptPvltObject(buf, fileKey, entry.file_id_hex);
    const isHeic =
      metadata.mime_type.includes("heic") || metadata.filename.toLowerCase().endsWith(".heic");
    const sourceBlob = isHeic
      ? await convertHeicToJpeg(plaintext)
      : new Blob([plaintext.buffer as ArrayBuffer], { type: metadata.mime_type });
    return makeImageThumbnail(sourceBlob);
  }

  async function loadThumbnail(entry: ManifestEntry) {
    if (!unlocked) return;
    const isVideo = entry.mime_type.includes("quicktime") || entry.mime_type.startsWith("video/");
    const isHeic = entry.mime_type.includes("heic") || entry.filename.toLowerCase().endsWith(".heic");
    if (thumbsRequested.current.has(entry.file_id_hex)) return;
    thumbsRequested.current.add(entry.file_id_hex);
    try {
      const cached = await getCachedThumb(entry.file_id_hex);
      if (cached) {
        setThumbs((prev) => ({ ...prev, [entry.file_id_hex]: URL.createObjectURL(cached) }));
        return;
      }

      let thumbBlob: Blob;
      // HEIC can't be decoded server-side here (no libheif in ffmpeg-static
      // or sharp's build) -- skip straight to the client-side WASM decoder
      // instead of wasting a round trip that's guaranteed to 422.
      if (isHeic) {
        thumbBlob = await loadThumbnailClientSide(entry);
      } else {
        try {
          const fileKey = await unwrapFileKey(
            unlocked.wrapKey,
            entry.wrap_nonce_hex,
            entry.wrapped_key_hex,
            entry.file_id_hex
          );
          const res = await fetch("/api/thumbnail", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              file_id_hex: entry.file_id_hex,
              file_key_hex: bytesToHex(fileKey),
              account: entry.extra?.pcloud_account,
              is_video: isVideo,
            }),
          });
          if (!res.ok) throw new Error("server thumbnail failed");
          thumbBlob = await res.blob();
        } catch {
          if (isVideo) return; // no client-side fallback for video posters
          thumbBlob = await loadThumbnailClientSide(entry);
        }
      }

      setThumbs((prev) => ({ ...prev, [entry.file_id_hex]: URL.createObjectURL(thumbBlob) }));
      void putCachedThumb(entry.file_id_hex, thumbBlob);
    } catch {
      // Thumbnail is best-effort; leave the icon placeholder on failure.
    }
  }

  function handleDownload() {
    if (!open?.downloadBlob) return;
    const url = URL.createObjectURL(open.downloadBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = open.entry.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function closeLightbox() {
    if (open?.objectUrl) URL.revokeObjectURL(open.objectUrl);
    setOpen(null);
  }

  function openByOffset(offset: number) {
    if (!open) return;
    const idx = visibleEntries.findIndex((e) => e.file_id_hex === open.entry.file_id_hex);
    if (idx === -1) return;
    const nextIdx = idx + offset;
    if (nextIdx < 0 || nextIdx >= visibleEntries.length) return;
    handleOpen(visibleEntries[nextIdx]);
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
    setSelectedIds((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds({});
  }

  async function decryptEntryToBlob(entry: ManifestEntry): Promise<Blob> {
    const accountQs = entry.extra?.pcloud_account
      ? `?account=${encodeURIComponent(String(entry.extra.pcloud_account))}`
      : "";
    const res = await fetch(`/api/object/${entry.file_id_hex}${accountQs}`);
    if (!res.ok) throw new Error("failed to fetch object");
    const buf = new Uint8Array(await res.arrayBuffer());
    const fileKey = await unwrapFileKey(
      unlocked!.wrapKey,
      entry.wrap_nonce_hex,
      entry.wrapped_key_hex,
      entry.file_id_hex
    );
    const { metadata, plaintext } = await decryptPvltObject(buf, fileKey, entry.file_id_hex);
    return new Blob([plaintext.buffer as ArrayBuffer], { type: metadata.mime_type });
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
        const blob = await decryptEntryToBlob(entry);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = entry.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
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

  // Removing the manifest entry only forgets the file locally -- the
  // encrypted blob stays on pCloud (there's no delete-object API route
  // yet). Documented in FEATURES.md as a known limitation.
  async function handleBulkDeletePermanently() {
    if (!unlocked) return;
    const ids = Object.keys(selectedIds);
    if (ids.length === 0) return;
    if (!window.confirm(`Permanently remove ${ids.length} item(s) from your library? The encrypted files will stay in cloud storage but won't be recoverable from this app.`)) {
      return;
    }
    const nextEntries = { ...unlocked.manifest.entries };
    for (const id of ids) delete nextEntries[id];
    await persistManifest({ ...unlocked.manifest, updated_ts: Date.now() / 1000, entries: nextEntries });
    clearSelection();
  }

  const allEntries = unlocked ? Object.values(unlocked.manifest.entries) : [];
  const libraryEntries = allEntries.filter((e) => !e.deleted);
  const trashEntries = allEntries.filter((e) => e.deleted);
  const baseEntries = view === "trash" ? trashEntries : libraryEntries;
  const searchLower = search.trim().toLowerCase();
  const visibleEntries = (searchLower
    ? baseEntries.filter((e) => e.filename.toLowerCase().includes(searchLower))
    : baseEntries
  ).sort((a, b) => b.added_ts - a.added_ts);

  useEffect(() => {
    libraryEntries.forEach((entry) => {
      void loadThumbnail(entry);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryEntries.map((e) => e.file_id_hex).join(",")]);

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

  // Group visible entries by day, preserving desc-sorted order.
  const dateGroups: { label: string; entries: ManifestEntry[] }[] = [];
  for (const entry of visibleEntries) {
    const label = dateGroupLabel(entry.added_ts);
    const last = dateGroups[dateGroups.length - 1];
    if (last && last.label === label) last.entries.push(entry);
    else dateGroups.push({ label, entries: [entry] });
  }

  const selectedCount = Object.keys(selectedIds).length;
  const zoomPx = ZOOM_PX[zoom];
  const gridMinPx = isMobile ? 96 : zoomPx;

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
                <button
                  className={`${styles.navItem} ${view === "library" ? styles.navItemActive : ""}`}
                  onClick={() => setView("library")}
                >
                  <span className={styles.navDot} data-active={view === "library"} />
                  <span>Library</span>
                </button>
                <button
                  className={styles.navItem}
                  disabled
                  title="Albums aren't implemented yet -- see FEATURES.md"
                >
                  <span className={styles.navDot} />
                  <span>Albums</span>
                  <span className={styles.navCount}>12</span>
                </button>
                <button
                  className={`${styles.navItem} ${view === "trash" ? styles.navItemActive : ""}`}
                  onClick={() => setView("trash")}
                >
                  <span className={styles.navDot} data-active={view === "trash"} />
                  <span>Trash</span>
                  {trashEntries.length > 0 && (
                    <span className={styles.navCount}>{trashEntries.length}</span>
                  )}
                </button>
              </nav>

              <div className={styles.foldersSection}>
                <div className={styles.foldersHeading}>Folders</div>
                <div
                  className={styles.folderRow}
                  title="Folders aren't implemented yet -- see FEATURES.md"
                  style={{ opacity: 0.45, cursor: "not-allowed" }}
                >
                  <span className={styles.folderSwatch} />
                  <span>Coming soon</span>
                </div>
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
                  {storage ? "Across all configured accounts" : "Loading usage..."}
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

          {/* ===== Mobile header ===== */}
          {isMobile && (
            <div className={styles.mobileHeader}>
              <div className={styles.mobileHeaderLeft}>
                <span className={styles.lockIcon}>🔒</span>
                <span className={styles.brandName}>Vault</span>
              </div>
              <div className={styles.mobileHeaderRight}>
                <button
                  className={styles.iconBtn}
                  onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                  aria-label="Toggle theme"
                >
                  {theme === "dark" ? "☀" : "☾"}
                </button>
              </div>
            </div>
          )}

          {/* ===== Main ===== */}
          <div className={styles.main}>
            <div className={styles.toolbar}>
              <div>
                <div className={styles.title}>{view === "trash" ? "Trash" : "Library"}</div>
                <div className={styles.subtitle}>
                  {visibleEntries.length} item{visibleEntries.length === 1 ? "" : "s"} · fully encrypted
                </div>
              </div>
              <div className={styles.toolbarActions}>
                {selectedCount > 0 && (
                  <button className={styles.textBtn} onClick={clearSelection}>
                    Cancel
                  </button>
                )}
                {!isMobile && (
                  <div className={styles.zoomGroup}>
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
                {view === "library" && (
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={busy}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {busy ? "Uploading..." : "↑ Upload"}
                  </button>
                )}
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

            {visibleEntries.length === 0 ? (
              <div className={styles.emptyState}>
                {view === "trash"
                  ? "Trash is empty."
                  : searchLower
                  ? "No items match your search."
                  : "No items yet. Upload a photo or video to get started."}
              </div>
            ) : (
              <div className={`${styles.gridScroll} om-scroll`}>
                {dateGroups.map((group) => (
                  <div key={group.label} className={styles.dateGroup}>
                    <div className={styles.dateLabel}>{group.label}</div>
                    <div
                      className={styles.grid}
                      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${gridMinPx}px, 1fr))` }}
                    >
                      {group.entries.map((entry) => {
                        const isHeic = entry.mime_type.includes("heic");
                        const isVideo =
                          entry.mime_type.includes("quicktime") || entry.mime_type.startsWith("video/");
                        const thumbUrl = thumbs[entry.file_id_hex];
                        const selected = !!selectedIds[entry.file_id_hex];
                        return (
                          <div
                            key={entry.file_id_hex}
                            className={`${styles.tile} ${selected ? styles.tileSelected : ""}`}
                            onClick={() => handleOpen(entry)}
                          >
                            {thumbUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={thumbUrl} alt={entry.filename} className={styles.thumbImg} />
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
                                toggleSelect(entry.file_id_hex);
                              }}
                              aria-label={selected ? "Deselect" : "Select"}
                            >
                              {selected && "✓"}
                            </button>
                            <div className={styles.lockBadge}>🔒</div>
                            {loadingIds.has(entry.file_id_hex) && (
                              <div className={styles.tileLoading}>
                                <span className={styles.spinner} />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ===== Mobile bottom tabs ===== */}
          {isMobile && (
            <div className={styles.bottomTabs}>
              <button
                className={`${styles.bottomTab} ${view === "library" ? styles.bottomTabActive : ""}`}
                onClick={() => setView("library")}
              >
                <span className={styles.navDot} data-active={view === "library"} />
                Library
              </button>
              <button
                className={styles.bottomTab}
                disabled
                title="Folders aren't implemented yet -- see FEATURES.md"
              >
                <span className={styles.navDot} />
                Folders
              </button>
              <button
                className={`${styles.bottomTab} ${view === "trash" ? styles.bottomTabActive : ""}`}
                onClick={() => setView("trash")}
              >
                <span className={styles.navDot} data-active={view === "trash"} />
                Trash
              </button>
            </div>
          )}

          {/* ===== Floating selection bar ===== */}
          {selectedCount > 0 && (
            <div className={styles.selectionBar}>
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

      {open && (() => {
        const idx = visibleEntries.findIndex((e) => e.file_id_hex === open.entry.file_id_hex);
        const hasPrev = idx > 0;
        const hasNext = idx !== -1 && idx < visibleEntries.length - 1;
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
                      {idx + 1} / {visibleEntries.length}
                    </span>
                  )}
                </div>
                <div className={styles.lightboxActions}>
                  <button
                    className={styles.btn}
                    onClick={handleDownload}
                    disabled={!open.downloadBlob}
                  >
                    {"↓ Download"}
                  </button>
                  {view === "trash" ? (
                    <button
                      className={styles.btn}
                      onClick={() => handleRestore(open.entry.file_id_hex)}
                    >
                      Restore
                    </button>
                  ) : null}
                  <button className={styles.btn} onClick={closeLightbox}>
                    Close
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
