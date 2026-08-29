@AGENTS.md

# Workflow

- After finishing any task in this repo, commit the changes (with a
  descriptive message) — don't wait to be asked each time.
- There is no git remote configured; deploys go out via the Vercel CLI
  (`vercel deploy`), not git push. So "commit and push" means commit only,
  unless a remote gets added later.
- `vault-data/` is local encrypted runtime data and is gitignored — never
  add it back to version control.
