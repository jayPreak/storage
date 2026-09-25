// Pure (client- and server-safe) helper for reading which backend/account
// holds a manifest entry's object. Kept separate from lib/storageServer.ts
// so the browser bundle never pulls in server-only code.
export type Backend = "pcloud" | "b2";

export interface BackendRef {
  backend: Backend;
  account: string;
}

// - extra.backend "pcloud" | "b2" -> new-style tag written by the webapp.
// - extra.pcloud_account only    -> legacy webapp upload, implicitly pCloud.
// - anything else (incl. the offline script's backend "rclone") -> null:
//   not browsable here, the server falls back to scanning pCloud accounts.
export function resolveBackend(extra: Record<string, unknown> | undefined): BackendRef | null {
  if (!extra) return null;
  if ((extra.backend === "pcloud" || extra.backend === "b2") && typeof extra.backend_account === "string") {
    return { backend: extra.backend, account: extra.backend_account };
  }
  if (extra.backend === undefined && typeof extra.pcloud_account === "string") {
    return { backend: "pcloud", account: extra.pcloud_account };
  }
  return null;
}
