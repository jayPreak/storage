@AGENTS.md

# Workflow

- After finishing any task in this repo, commit AND push to `origin main`
  (https://github.com/jayPreak/storage) — don't wait to be asked each time.
- The Vercel project `webapp` is git-connected to that repo, so pushing to
  `main` triggers a deployment automatically. No need to run
  `vercel deploy` manually.
- `vault-data/` is local encrypted runtime data and is gitignored — never
  add it back to version control.
