@AGENTS.md

# Workflow

- After finishing any task in this repo, commit AND push to `origin main`
  (https://github.com/jayPreak/storage) — don't wait to be asked each time.
- The Vercel project `webapp` is git-connected to that repo, so pushing to
  `main` triggers a deployment automatically. No need to run
  `vercel deploy` manually.
- `vault-data/` is local encrypted runtime data and is gitignored — never
  add it back to version control.

# Bulk photo/video import

- `scripts/upload-iphone-pics.mjs` bulk-imports a local folder (default
  `~/Downloads/iphone pics`) into the pCloud vault, alphabetically, using
  the same crypto (`lib/vaultCrypto.ts`) and pCloud upload/manifest calls
  as the app itself — see the README section "Bulk-importing local
  photos/videos" for full behavior.
- Never type, log, or pass the vault passphrase yourself when running or
  discussing this script — it prompts for hidden terminal input from the
  user directly. Don't add a flag/env var that would let the passphrase be
  supplied non-interactively.
- It stops automatically once no configured pCloud account has free quota
  for the next file — that's the intended behavior, not a bug to fix.
- Its progress log (`~/vault-upload-results.txt`) contains real filenames
  from the user's personal photo library — never commit it, cat it into a
  shared context, or otherwise treat it as safe-to-publish repo content.
