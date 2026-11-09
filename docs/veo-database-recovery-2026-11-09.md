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
available and the filesystem was not mounted read-only. At 07:51, authenticated
management logs confirmed repeated SQLSTATE `53100` failures creating
`pg_wal/xlogtemp.*`: `No space left on device`. Recovery then shut PostgreSQL
down and repeated approximately every six seconds. This establishes a disk-full
startup loop. It does not establish how much space WAL versus application tables
occupies, or what originally filled the volume. Memory had about 246 MB available, with no
OOM kills reported since the latest host boot; this does not exclude an earlier
memory failure.

Recover storage capacity before running migrations or resuming writes. Supabase
documents a fixed 2 GB disk on Free plans, and recommends upgrading to Pro then
restarting when a full disk has shut PostgreSQL down. Paid projects can expand
disk through Database Settings. If a resize cannot run or startup still fails,
provider support needs the project reference, startup error and these metrics.
Plan changes require the account owner's billing approval. See
[Supabase disk recovery documentation](https://supabase.com/docs/guides/platform/database-size#free-plan-behavior).

The owner requested recovery on the existing plan. At 07:54, the Management API
accepted a normal managed pause of the existing project (`POST /pause`, HTTP
200), without force options, a billing change or application-table deletion.
Monitor the project state, then verify restore information before resuming. Do
not restore the November 3 local migration backup over current data. The active
project's downloadable backup list was empty before pausing. A project-list
status of `ACTIVE_HEALTHY` did not reflect PostgreSQL's actual failed health.
By 08:12, the pause attempt had returned to `ACTIVE_HEALTHY` without recovering
PostgreSQL: metrics still showed `pg_up = 0` and 13,824,000 available bytes,
SQL connections returned `08006`, and fresh logs repeated the same `53100`
startup failure. Do not treat that project-list status as a successful recovery.

The earlier raw-history cleanup is independently confirmed by its saved receipt:
554,206 raw message rows became zero and the raw transcript table was dropped.
It retained 49,745 contacts and 100,135 profile snapshots. Multiple profile
versions remain candidates for inspection, rather than proof of duplicate
contacts or the crash cause. Preserve all tags and contact-tag assignments.

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
