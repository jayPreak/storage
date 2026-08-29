import path from "node:path";

// Bundled copy of the encrypted vault (ciphertext-only: manifest.enc,
// vault.config.json, objects/*.pvlt) so this app can be deployed
// standalone (e.g. to Vercel) without needing access to the sibling
// `vault/` Python project's local filesystem path. It is only ever read
// from disk, never written to, by these API routes. Refresh this copy
// (`cp -R ../vault/data/test_vault/* ./vault-data/`) whenever the source
// vault changes.
export const VAULT_DIR = path.resolve(process.cwd(), "vault-data");

export const CONFIG_PATH = path.join(VAULT_DIR, "vault.config.json");
export const MANIFEST_PATH = path.join(VAULT_DIR, "manifest.enc");
export const OBJECTS_DIR = path.join(VAULT_DIR, "objects");

const FILE_ID_HEX_RE = /^[0-9a-f]{32}$/i;

/**
 * Validates that a candidate file id is exactly a 32-hex-char (16-byte)
 * identifier before it is ever concatenated into a filesystem path -- this
 * is what stops a request like `../../../etc/passwd` (or any non-hex
 * value) from being used to escape the objects/ directory.
 */
export function isValidFileIdHex(candidate: string): boolean {
  return FILE_ID_HEX_RE.test(candidate);
}

export function objectPathForFileId(fileIdHex: string): string {
  if (!isValidFileIdHex(fileIdHex)) {
    throw new Error("invalid file id");
  }
  return path.join(OBJECTS_DIR, `${fileIdHex}.pvlt`);
}
