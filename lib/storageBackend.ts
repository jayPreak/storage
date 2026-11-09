// Pure (client- and server-safe) helper for reading which backend/account
// holds a manifest entry's object. Kept separate from lib/storageServer.ts
// so the browser bundle never pulls in server-only code.
export type Backend = "pcloud" | "b2" | "mega";

export interface BackendRef {
  backend: Backend;
  account: string;
}

// - extra.backend "pcloud" | "b2" | "mega" -> new-style tag written by the webapp.
// - extra.pcloud_account only    -> legacy webapp upload, implicitly pCloud.
// - extra.backend "rclone"       -> the offline bulk-import script's tag for
//   objects it wrote through rclone. MEGA is the only rclone-written remote
//   the webapp can browse (same `vault/<id>.pvlt` layout), so these resolve
//   to "mega"; for any other account name the server's account lookup simply
//   misses and answers "not found".
// - anything else -> null: the server falls back to scanning pCloud accounts.
export function resolveBackend(extra: Record<string, unknown> | undefined): BackendRef | null {
  if (!extra) return null;
  if ((extra.backend === "pcloud" || extra.backend === "b2" || extra.backend === "mega") && typeof extra.backend_account === "string") {
    return { backend: extra.backend, account: extra.backend_account };
  }
  if (extra.backend === "rclone" && typeof extra.backend_account === "string") {
    return { backend: "mega", account: extra.backend_account };
  }
  if (extra.backend === undefined && typeof extra.pcloud_account === "string") {
    return { backend: "pcloud", account: extra.pcloud_account };
  }
  return null;
}
