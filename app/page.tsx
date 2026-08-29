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
};

const PRELOAD_STEPS = [5, 10, 15, 20];
const PRELOAD_STEP_DELAY_MS = 150;
const THUMB_SIZE = 240;

async function makeImageThumbnail(blob: Blob): Promise<string> {
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
  const thumbBlob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", 0.75)
  );
  return URL.createObjectURL(thumbBlob);
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
  const [visibleCount, setVisibleCount] = useState(0);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbsRequested = useRef<Set<string>>(new Set());

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

  async function handleOpen(entry: ManifestEntry) {
    if (!unlocked) return;
    setError("");
    setTileLoading(entry.file_id_hex, true);
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
          setOpen({
            entry,
            objectUrl: URL.createObjectURL(jpegBlob),
            mime: "image/jpeg",
            note: "Converted from HEIC to JPEG entirely in your browser for preview. Download gets you the original HEIC bytes.",
            downloadBlob: rawBlob,
          });
        } catch (decodeErr) {
          setOpen({
            entry,
            objectUrl: null,
            mime: metadata.mime_type,
            note: `Decrypted successfully, but this HEIC/HEIF variant couldn't be decoded for preview in-browser: ${
              decodeErr instanceof Error ? decodeErr.message : String(decodeErr)
            }. You can still download the original file.`,
            downloadBlob: rawBlob,
          });
        }
      } else if (isMov) {
        setStatus(`Transcoding ${entry.filename} for playback...`);
        try {
          const transcodeRes = await fetch("/api/transcode", {
            method: "POST",
            body: rawBlob,
          });
          if (!transcodeRes.ok) throw new Error("transcode failed");
          const mp4Blob = await transcodeRes.blob();
          setOpen({
            entry,
            objectUrl: URL.createObjectURL(mp4Blob),
            mime: "video/mp4",
            note: "Transcoded from HEVC/.mov to H.264 for in-browser playback. Download gets the original file.",
            downloadBlob: rawBlob,
          });
        } catch (transcodeErr) {
          setOpen({
            entry,
            objectUrl: URL.createObjectURL(rawBlob),
            mime: metadata.mime_type,
            note: `Transcoding failed (${
              transcodeErr instanceof Error ? transcodeErr.message : String(transcodeErr)
            }); some browsers can't play H.264/HEVC .mov via <video> (Safari usually can). If playback fails, download the file instead.`,
            downloadBlob: rawBlob,
          });
        }
      } else {
        setOpen({
          entry,
          objectUrl: URL.createObjectURL(rawBlob),
          mime: metadata.mime_type,
          note: "",
          downloadBlob: rawBlob,
        });
      }

      setStatus(`Decrypted ${entry.filename} (${plaintext.length} bytes).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTileLoading(entry.file_id_hex, false);
    }
  }

  async function loadThumbnail(entry: ManifestEntry) {
    if (!unlocked) return;
    const isImage = entry.mime_type.startsWith("image/") || entry.mime_type.includes("heic");
    if (!isImage) return;
    if (thumbsRequested.current.has(entry.file_id_hex)) return;
    thumbsRequested.current.add(entry.file_id_hex);
    try {
      const accountQs = entry.extra?.pcloud_account
        ? `?account=${encodeURIComponent(String(entry.extra.pcloud_account))}`
        : "";
      const res = await fetch(`/api/object/${entry.file_id_hex}${accountQs}`);
      if (!res.ok) return;
      const buf = new Uint8Array(await res.arrayBuffer());
      const fileKey = await unwrapFileKey(
        unlocked.wrapKey,
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
      const thumbUrl = await makeImageThumbnail(sourceBlob);
      setThumbs((prev) => ({ ...prev, [entry.file_id_hex]: thumbUrl }));
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
        const manifestBlob = await encryptManifest(unlocked.headerKey, manifest);
        const manifestRes = await fetch("/api/manifest", {
          method: "POST",
          body: manifestBlob as BodyInit,
        });
        if (!manifestRes.ok) throw new Error("failed to save manifest");

        setUnlocked((prev) => (prev ? { ...prev, manifest } : prev));
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

  const entries = unlocked
    ? Object.values(unlocked.manifest.entries).filter((e) => !e.deleted)
    : [];

  useEffect(() => {
    if (entries.length === 0) {
      setVisibleCount(0);
      return;
    }
    const nextStep = PRELOAD_STEPS.find((step) => step > visibleCount);
    if (nextStep === undefined || visibleCount >= entries.length) return;
    const timer = setTimeout(() => {
      setVisibleCount(Math.min(nextStep, entries.length));
    }, PRELOAD_STEP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [entries.length, visibleCount]);

  const visibleEntries = entries.slice(0, visibleCount);

  useEffect(() => {
    visibleEntries.forEach((entry) => {
      void loadThumbnail(entry);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEntries.map((e) => e.file_id_hex).join(",")]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        {!unlocked ? (
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
        ) : (
          <div className={styles.shell}>
            <div className={styles.topbar}>
              <div className={styles.brand}>
                <h1>Vault</h1>
                <span>{entries.length} items</span>
              </div>
              <div className={styles.topActions}>
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
                <button
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {busy ? "Uploading..." : "↑ Upload"}
                </button>
              </div>
            </div>

            {(status || error) && (
              <div>
                {status && !error && (
                  <div className={styles.statusBar}>
                    {busy && <span className={styles.spinner} />}
                    {status}
                  </div>
                )}
                {error && <div className={styles.errorBar}>{error}</div>}
              </div>
            )}

            {entries.length === 0 ? (
              <div className={styles.emptyState}>
                No items yet. Upload a photo or video to get started.
              </div>
            ) : (
              <div className={styles.filmstrip}>
                {visibleEntries.map((entry) => {
                  const isHeic = entry.mime_type.includes("heic");
                  const isVideo = entry.mime_type.includes("quicktime") || entry.mime_type.startsWith("video/");
                  const thumbUrl = thumbs[entry.file_id_hex];
                  return (
                    <button
                      key={entry.file_id_hex}
                      className={styles.tile}
                      onClick={() => handleOpen(entry)}
                    >
                      {thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumbUrl} alt={entry.filename} className={styles.thumbImg} />
                      ) : (
                        <div className={styles.tilePlaceholder}>
                          <div className={styles.tileIcon}>
                            {isVideo ? "\u{1F3A5}" : "\u{1F5BC}️"}
                          </div>
                        </div>
                      )}
                      <div className={styles.tileOverlay}>
                        <div className={styles.tileName}>{entry.filename}</div>
                        <div className={styles.tileMeta}>
                          {(entry.size / 1024).toFixed(0)} KiB
                          {isHeic ? " · HEIC" : ""}
                        </div>
                      </div>
                      {loadingIds.has(entry.file_id_hex) && (
                        <div className={styles.tileLoading}>
                          <span className={styles.spinner} />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>

      {open && (
        <div className={styles.lightboxOverlay} onClick={closeLightbox}>
          <div className={styles.lightbox} onClick={(e) => e.stopPropagation()}>
            <div className={styles.lightboxHeader}>
              <div className={styles.lightboxTitle}>{open.entry.filename}</div>
              <div className={styles.lightboxActions}>
                <button
                  className={styles.btn}
                  onClick={handleDownload}
                  disabled={!open.downloadBlob}
                >
                  {"↓ Download"}
                </button>
                <button className={styles.btn} onClick={closeLightbox}>
                  Close
                </button>
              </div>
            </div>
            {open.note && <div className={styles.lightboxNote}>{open.note}</div>}
            <div className={styles.lightboxBody}>
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
              {!open.objectUrl && (
                <div className={styles.lightboxFallback}>
                  <div style={{ fontSize: 48 }}>{"\u{1F5BC}️"}</div>
                  <div>No preview available -- use Download to get the file.</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
