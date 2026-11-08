# Database recovery and bounded hierarchy traversal

The source SQL used recursive `UNION ALL` hierarchy walks without detecting
cycles. A cyclic or corrupted staff graph could keep permission and reporting
queries running indefinitely. This is a confirmed code risk; a production cycle
has not been verified while PostgreSQL refuses connections.

`202611090001_veo_hierarchy_recursion_guards.sql` makes the branch, ancestor-grant
and page-permission walks stop on repeated identities or at 64 levels. Invalid
graphs fail closed. Departed staff remain historical hierarchy nodes, and normal
Page-grant inheritance stays unchanged. The migration does not rewrite accounts
or financial records.

Set the production environment variable `VEO_DATABASE_RECOVERY_MODE=true` and
redeploy to stop application database reads and scheduled workers during
recovery. Provider/CSRF/sign-out endpoints remain available. In workspace mode,
Facebook webhook GET verification stays available. Facebook event ingestion and
Telegram callbacks return 503 before database work: an offline or nearly full
database cannot safely persist an inbox event. Unsaved deliveries are never
acknowledged as successful.

At 2026-11-09 06:45 Asia/Manila, the provider Metrics API reported `pg_up = 0`
and 13,824,000 bytes available on the 2,077,073,408-byte `/data` filesystem
(0.67%). Total free bytes including reserved space were 135,458,816. Inodes were
available and the filesystem was not mounted read-only. This confirms critically
low usable disk space while PostgreSQL is down; the startup log is still needed
to establish the exact failure. WAL size and the reason for growth are unknown
while SQL connections are refused. Memory had about 246 MB available, with no
OOM kills reported since the latest host boot; this does not exclude an earlier
memory failure.

Recover storage capacity before running migrations or resuming writes. Supabase
documents a fixed 2 GB disk on Free plans, and recommends upgrading to Pro then
restarting when a full disk has shut PostgreSQL down. Paid projects can expand
disk through Database Settings. If a resize cannot run or startup still fails,
provider support needs the project reference, startup error and these metrics.
Plan changes require the account owner's billing approval. See
[Supabase disk recovery documentation](https://supabase.com/docs/guides/platform/database-size#free-plan-behavior).

After storage headroom is restored and the database accepts connections, run:

```powershell
node --env-file=.env.local scripts/repair-veo-hierarchy.mjs --inspect
node --env-file=.env.local scripts/repair-veo-hierarchy.mjs --apply
```

The repair validates the configured project and all four existing function
bodies before applying only this migration in a bounded transaction. An
unexpected production definition stops the repair for review. Existing
operator-set function limits are retained. The ordinary full migration runner
must not be used to install unrelated pending changes during this incident.

Verify simple reads and owner/staff scope before setting recovery mode to false
and redeploying. Check queue health after workers resume. If the database remains
unhealthy with application work quiesced, collect PostgreSQL startup/resource
logs through project-management access before attributing the crash to a
particular query.
