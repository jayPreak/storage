This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## pCloud-backed object storage

This app stores encrypted objects (`<file_id>.pvlt`) and the encrypted manifest (`manifest.enc`) in one or more pCloud accounts instead of local disk -- required because Vercel functions have no persistent filesystem. See `lib/pcloudServer.ts` for the client and `app/api/{upload,object/[fileId],manifest}/route.ts` for the routes that use it.

Configure via the `PCLOUD_ACCOUNTS` env var, a JSON array in fill-priority order:

```
PCLOUD_ACCOUNTS=[{"name":"pcloud1","token":"..."}]
```

For local dev, put this in `webapp/.env.local` (already gitignored via `.env*`).

For production on Vercel:

```bash
vercel env add PCLOUD_ACCOUNTS production
# paste the same JSON array shape when prompted
```

### Adding another account once one fills up

Uploads automatically overflow to the next account in the array once the current one's free quota drops below the file size plus a safety margin. To add a new account:

1. Run `rclone config` locally to add a new pCloud remote and complete its OAuth flow.
2. Pull the new access token out of `~/.config/rclone/rclone.conf`.
3. Append `{"name":"pcloud2","token":"..."}` to the `PCLOUD_ACCOUNTS` JSON array (order = fill priority).
4. Update the Vercel env var (`vercel env add PCLOUD_ACCOUNTS production` again, or via the dashboard) and update `webapp/.env.local` for local dev.

No code changes are needed -- `pickAccountForUpload` in `lib/pcloudServer.ts` iterates whatever accounts are configured.

## Bulk-importing local photos/videos (`scripts/upload-iphone-pics.mjs`)

For importing a large local folder (e.g. `~/Downloads/iphone pics`) without
clicking through the browser upload one file at a time. It's a standalone
Node script that re-implements the exact same pipeline as the app --
`lib/vaultCrypto.ts`'s Argon2id key derivation + chunked AES-256-GCM `.pvlt`
encryption, and the same pCloud upload/manifest-update calls as
`app/api/upload` and `app/api/manifest` -- so anything it uploads shows up
in the webapp UI exactly as if it had been dragged in there.

Run from `webapp/`:

```bash
node scripts/upload-iphone-pics.mjs
```

It prompts for the vault passphrase with hidden terminal input -- the
passphrase is never passed as a CLI arg, env var, or sent anywhere but into
the local Argon2id derivation, matching the app's "passphrase never leaves
this device" guarantee. Don't pipe or script the passphrase into it.

Behavior:

- Reads `PCLOUD_ACCOUNTS` from `.env.local` and fetches the real
  `vault.config.json` + `manifest.enc` from the primary account's `vault`
  folder on pCloud (falls back to the bundled `vault-data/` copy if pCloud
  doesn't have them yet).
- Walks the watch folder (`~/Downloads/iphone pics` by default) alphabetically,
  for files with extension `.mov .heic .jpg .jpeg .png .mp4`.
- Skips any filename already present in the manifest, so it's safe to
  interrupt and re-run (resumes where it left off).
- Before each file, checks free quota across configured accounts (same
  `pickAccountForUpload` logic as the API route) and **stops automatically**
  once no account has room -- this is the intended way to "fill up" the
  configured free-tier storage rather than erroring out.
- Encrypts, uploads, and re-uploads the updated manifest after every
  successful file, so progress is durable even if the run is interrupted.
- Logs every action live to `~/vault-upload-results.txt`, and at the end
  re-fetches the manifest from pCloud to cross-check every uploaded file is
  actually present there -- the same manifest the webapp reads on unlock.
- Does **not** compress -- it mirrors `vaultCrypto.ts`, which encrypts only.
  If compression is added to the app's pipeline, this script needs the same
  change to stay byte-compatible.

To point it at a different folder, edit `WATCH_DIR` at the top of the
script (it isn't read from an env var, unlike the Python watcher's
`VAULT_WATCH_DIR`).
