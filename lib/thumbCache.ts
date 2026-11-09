// Local-only cache of generated preview thumbnails (small downscaled JPEGs),
// keyed by file id. This never stores anything the server can see -- it's
// purely a browser-side speedup so re-opening the vault on the same device
// doesn't have to re-download and re-decrypt every full-size photo just to
// redraw a 240px thumbnail.
const DB_NAME = "vault-thumb-cache";
const STORE = "thumbs";

// One shared connection for the life of the tab. Opening a fresh one per
// get/put (hundreds per scroll) was slow on iOS Safari, and the connections
// were never closed.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      // If the browser closes it (storage pressure, version change), reopen next time.
      db.onclose = () => {
        if (dbPromise === p) dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise = p;
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

export async function getCachedThumb(fileIdHex: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(fileIdHex);
      req.onsuccess = () => resolve((req.result as Blob) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function putCachedThumb(fileIdHex: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, fileIdHex);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Cache is best-effort; ignore write failures (e.g. private browsing).
  }
}
