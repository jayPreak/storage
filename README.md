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
