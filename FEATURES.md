# Design vs. implementation status

Source of the design: `../Library View.dc.html` (+ `../support.js`, the
generic Claude-design runtime that renders it — not app-specific, nothing to
port from that file). This tracks what from that design is live in
`app/page.tsx` / `app/page.module.css`, what's stubbed, and what's not
started, so future work doesn't have to re-diff the two.

## Implemented

- **Sidebar shell** (desktop) / **top header + bottom tabs** (mobile,
  `<860px` breakpoint) — matches the design's responsive layout.
- **Library nav item** — real, filters to non-deleted manifest entries.
- **Trash nav item** — real. Backed by the `deleted` boolean that already
  existed on `ManifestEntry` but had no UI. Supports per-item and bulk
  Restore, and permanent delete (see caveat below).
- **Search box** — real, client-side substring filter over `filename`.
- **Date-grouped grid** ("Today" / "Yesterday" / "Month D" / "Month D, YYYY")
  — computed from `added_ts`, grouping adjacent same-day entries.
- **Zoom control (S/M/L/XL)** — real, resizes grid tile `minmax()`, persisted
  to `localStorage`.
- **Dark/light theme toggle** — real, persisted to `localStorage`. Implemented
  as CSS variable overrides on `.page[data-theme="light"]` rather than the
  design's `oklch()`-generated palette, since the app already had a fixed
  dark palette to build from.
- **Storage usage card** — real numbers, not the design's placeholder
  "82.4 / 250 GB". New `GET /api/storage` route sums `quota`/`usedquota`
  across every account in `PCLOUD_ACCOUNTS` via the existing
  `getQuota()` in `lib/pcloudServer.ts`.
- **Selection mode** — real. Tapping the checkbox overlay (top-left of a
  tile) selects it without opening the lightbox; tapping the tile itself
  still opens it, same as before.
- **Floating selection bar — Download** — real, decrypts and downloads each
  selected file.
- **Floating selection bar — Delete** — real, sets `deleted: true` on
  selected entries and persists the manifest (i.e. moves to Trash, doesn't
  erase anything remotely).
- **Restore from Trash** — real, per-item (in the lightbox, when viewing
  Trash) and bulk (selection bar).

## Implemented as explicit stubs (visible, disabled, documented in-UI)

These render per the design but are disabled with a tooltip/toast pointing
back here, rather than silently doing nothing:

- **Albums nav item** — no album/collection concept exists anywhere in the
  data model (`vault/manifest.py`, `ManifestEntry`). Would need a new
  manifest field (e.g. `album_ids: string[]`) plus UI to create/assign them.
- **Folders section** — same story as Albums; no folder concept in the
  manifest today.
- **Share action** (selection bar) — no sharing mechanism exists (no
  link-generation endpoint, no re-wrapping a file key for a second
  recipient). Would need real design work, not just a UI hookup — vault
  keys are derived from one passphrase.
- **Move action** (selection bar) — depends on Folders existing first.

## Partial / caveat

- **"Delete permanently" (Trash)** — removes the entry from the manifest
  (so it disappears from the app and can't be restored), but does **not**
  delete the underlying `<file_id>.pvlt` blob from pCloud — there's no
  delete-object API route yet (`app/api/object/[fileId]/route.ts` only
  supports `GET`). The confirmation dialog says this explicitly. Adding a
  real delete would need a `DELETE` handler there plus a pCloud
  `deletefile` call.
- **Storage usage card "82.4 / 250 GB" copy** — the design assumed a fixed
  250GB target; the real number varies by however many `PCLOUD_ACCOUNTS`
  are configured (currently ~6GB total quota, one account). No fixed
  target to compare against, so the footer just says "Across all
  configured accounts" instead of the design's "Plenty of room left"
  (which would need an arbitrary threshold to decide when to say that).

## Not started

- **Drag-to-select / marquee selection** — design doesn't show this either,
  but common in this pattern; not present in either version.
- Any multi-user / sharing infra beyond the single-passphrase model.

## Verification notes for whoever picks this up next

- `npx tsc --noEmit`, `npx eslint app/page.tsx`, and `npx next build` all
  pass clean as of this change.
- **Not verified in a real browser** — this environment has no browser/
  screenshot tool available. Only checked via `curl` that `/` and
  `/api/storage` respond correctly. Before trusting the selection mode,
  trash flow, zoom control, and theme toggle, click through them manually
  (`npm run dev`, unlock with the real passphrase) at least once.
