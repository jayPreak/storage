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

No code changes are needed -- `pickAccountForUpload` in `lib/storageServer.ts` iterates whatever accounts are configured.

## Backblaze B2 accounts (`B2_ACCOUNTS`)

B2 buckets join the same upload pool: `pickAccountForUpload` (`lib/storageServer.ts`) tries every pCloud account first, then every B2 account, each in env-var order, first fit wins. Configure via a JSON array:

```
B2_ACCOUNTS=[{"name":"b2main","keyId":"...","applicationKey":"...","bucketId":"...","bucketName":"vault-b2main","quotaBytes":10000000000}]
```

- `quotaBytes` is your self-imposed cap (B2 has no quota API). A 200MB safety margin is kept below it.
- B2 has no live "used bytes" API, so usage is tracked in the `b2` section of the unencrypted `storage-summary.json` (primary pCloud account's `vault` folder), updated by the webapp after every B2 upload/delete. `scripts/upload-iphone-pics.mjs` uses the same pool order (pCloud, then `B2_ACCOUNTS`, then any other rclone remotes) and updates the same ledger; it never treats a `B2_ACCOUNTS` bucket as a plain rclone remote. If the ledger ever drifts, re-derive it from a `rclone size b2main:vault-b2main`.
- Objects live at `vault/<fileId>.pvlt`, thumbnails at `vault-thumbs/<fileId>.pvlt`. Manifest entries are tagged `extra: {backend: "b2", backend_account}`.

### Adding another B2 account

Each Backblaze account's free tier is 10GB, so each extra account is +10GB. Use one bucket per account.

**Naming.** Pick one short name and use it everywhere: `b2second` for the rclone remote and the `B2_ACCOUNTS` `name`, and `vault-b2second` for the bucket (same pattern as `b2main` / `vault-b2main`; `b2third` / `vault-b2third` next). Bucket names are globally unique across all of B2 -- if it's taken, add a suffix (e.g. `vault-b2second-jp`); only the bucket name changes, the account name stays `b2second`. Never rename the account `name` after uploading: manifest entries store it to find their files.

**1. Backblaze website**

- Sign up at backblaze.com -> **B2 Cloud Storage** (not Computer Backup) -> "Sign Up" with an email you haven't used for Backblaze before (each account = its own 10GB). No card is needed for the free tier. Verify the email, then sign in.
- In the left sidebar under **B2 Cloud Storage**: **Buckets** -> **Create a Bucket**
  - Bucket Unique Name: `vault-b2second`
  - Files in Bucket are: **Private**
  - Default Encryption: **Disable** (files are already end-to-end encrypted)
  - Object Lock: **Disable** (it would block deletes)
- Left sidebar -> **Application Keys** -> **Add a New Application Key** (don't use the Master Application Key at the top of that page -- it can touch every bucket)
  - Name of Key: `vault-b2second-webapp`
  - Allow access to Bucket(s): `vault-b2second` (not "All")
  - Type of Access: **Read and Write**
  - Allow List All Bucket Names: leave unchecked; File name prefix and Duration: leave empty
  - **Create New Key**. The confirmation shows `keyID` (starts with `00...`, ~25 chars) and `applicationKey` (starts with `K00...`, ~31 chars). Copy both now -- `applicationKey` is shown **only once**; if you lose it, delete the key and make a new one.

**2. rclone remote** (holds the key locally so nothing gets pasted into files by hand)

```bash
rclone config
```

`n` (new remote) -> name `b2second` -> storage `b2` -> `account` = the keyID -> `key` = the applicationKey -> `hard_delete` = `true` -> accept the defaults for the rest -> `q`. Then check it:

```bash
rclone lsd b2second:
```

It should list `vault-b2second`.

**3. Add it to `.env.local`** (run from `webapp/`)

```bash
node scripts/add-b2-account.mjs b2second vault-b2second
```

This reads the key from the rclone remote, looks up the `bucketId` (B2's upload API needs it), checks the bucket is Private and the key has read/write/delete/list access, and appends `{name, keyId, applicationKey, bucketId, bucketName, quotaBytes}` to `B2_ACCOUNTS` -- appended means it fills after the earlier B2 accounts. Optional third argument: `quotaBytes` (default `10000000000`). Re-running it for an existing name updates that entry in place.

**4. Push it to Vercel and deploy** (from `webapp/`; `B2_ACCOUNTS` is Sensitive, so it's replaced rather than edited)

```bash
vercel env rm B2_ACCOUNTS production --yes
```

```bash
grep '^B2_ACCOUNTS=' .env.local | cut -d= -f2- | vercel env add B2_ACCOUNTS production --sensitive
```

```bash
git commit --allow-empty -m "Redeploy for new B2 account" && git push origin main
```

Env changes only apply on the next deploy, hence the empty commit. Between the `rm` and the deploy finishing, the live site still runs with the old value, so there's no downtime.

**5. Check it**

```bash
curl -s https://jaystorage.vercel.app/api/storage
```

The new account should appear in `accounts` with `"backend":"b2"` and `usedquota: 0`. No code changes are needed: the webapp and `scripts/upload-iphone-pics.mjs` both pick it up from `B2_ACCOUNTS`.

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
