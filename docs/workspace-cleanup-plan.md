# VeoBot workspace inventory and cleanup record

Audited and cleaned 2026-11-04. This records the workspace layout and the cleanup completed without moving repositories or archived customer data.

## Current layout

- `../` is the VeoBot workspace root. It contains the small Express service, shared `data/` archives, reports, and generated assets.
- `tokko-chatbot/` is the production Next.js dashboard repository. Its historical local directory name remains because workspace scripts and Git worktrees refer to it; its Git remote and Vercel project are both `veochatbot`.
- Both the workspace `.env` and this dashboard's `.env.local` point to the VeoBot Supabase project. The dashboard runtime explicitly rejects the former shared Supabase project.
- `../tokkodev/` is a separate, dirty TOKKOdev Git worktree with ignored local analysis output. It remains in place to preserve its uncommitted work and registered worktree links. Its local Supabase and Postgres connection variables have been removed; it is not an application database source.
- `../tokkodev-echo-fix/` is a linked TOKKOdev branch worktree. Preserve it until its Git worktree relationship and unique changes are reviewed.
- `../../tokkodev/` is another checkout outside the VeoBot workspace and points at a different Supabase project. It is outside this cleanup scope.
- The workspace root also contains the small Express service, shared `data/` archives, and generated outputs. These were left in place because existing scripts consume them.

## Completed cleanup

1. Kept the two VeoBot apps separate and preserved the dashboard's Git history and `.vercel` project link.
2. Moved the partner Meta app secret into the VeoBot dashboard's ignored `.env.local`; dashboard diagnostics now read it from VeoBot configuration instead of `tokkodev/.env.local`.
3. Removed the old Supabase URL, anon/service keys, and Postgres URLs from the ignored TOKKOdev `.env.local`. No database rows or repository files were touched in that checkout.
4. Kept TOKKOdev and its linked worktree in place because its checkout has uncommitted/ignored analysis work and registered worktree relationships. Its folder rename or deletion needs a separate, Git-aware archival move after its remaining consumers are accounted for.
5. Kept historical references to the former project only in migration safety checks and the runtime guard that rejects it for VeoBot.

## Follow-up health audit

- The root Express prototype is not the production app: its typecheck fails because it calls Supabase query-builder methods on a PostgreSQL `Pool`, and its schema initializer is incompatible with the maintained VeoBot schema. Its local Supabase/Postgres credentials were removed and its README now marks it as archived, preventing an accidental connection to production. The production dashboard config and chatbot setup remain in `tokko-chatbot/`.

## Do not remove

- VeoBot Supabase data, chatbot configuration, Page tokens, knowledge documents, or local conversation archives.
- The existing dashboard Git history or `.vercel` project link.
- Legacy analysis files until their consumers have been redirected and their copies verified.

## Not changed

- No Supabase project or database rows were deleted or modified. The old project is simply no longer configured in the in-workspace TOKKOdev environment.
- No chatbot knowledge, setup, Page data, local conversation archive, or Git history was removed.
- The unrelated checkout outside this workspace was not changed.
