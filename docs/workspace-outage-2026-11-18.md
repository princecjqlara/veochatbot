# Workspace outage: 18 November 2026

The public production page returned HTTP 200, but fresh signed-member receipt
context and inbox requests returned HTTP 503 after approximately 18 seconds.
The PostgreSQL session pooler independently returned `EAUTHQUERY: connection to
database not available`. The monitoring endpoint also timed out. This locates
the immediate failure below the page and receipt form. Current measurements
do not establish the database's resource usage or the underlying outage cause.

Previous load measurements and recovery history are in
[the 15 November recovery notes](workspace-recovery-2026-11-15.md). Those
measurements must not be represented as current monitoring.

## Safeguards

- `VEO_BACKGROUND_PAUSED_UNTIL` accepts an absolute ISO timestamp. Until that
  time, authenticated cron requests return HTTP 503 with explicit deferral and
  retry guidance before reaching database code. Expired, invalid and absent
  values resume normal handling automatically. Staff requests, sign-in and
  webhook intake keep their existing authorization paths.
- An unavailable session displays a reconnect screen and withholds private
  workspace tools. Reconnecting refreshes current access; it does not trust
  cached role or suspension information.
- The workspace worker continues already-approved receipt delivery checks
  when automatic approval is busy or unavailable. It reports HTTP 503 and an
  explicit retry flag instead of presenting that phase as successful.
- Migration `202611180001` adds one shared, nonblocking transaction advisory
  lock to six heavy background SQL functions. A competing transaction receives
  SQLSTATE `55P03` before doing the original work. Commit, rollback or connection
  termination releases the lock. Function parameters, defaults, owner, grants,
  configuration and original calculations are preserved. Interactive access
  checks and receipt submission do not acquire this lock.

The SQL change must be installed before it can protect production. Application
deployment alone does not install it. A passing build or a public HTTP 200 is
also insufficient evidence that the workspace has recovered.

## Recovery and verification

1. Check Supabase project `mjuluaqrvbnycisnarzi` using connected administration.
   Retain available activity and resource diagnostics. Recover the existing
   unreachable service; inspect provider incidents and resource limits before
   considering any paid capacity change.
2. Once SQL is reachable, perform the migration's rollback preflight, compare
   existing operational records and function properties, then apply it through
   the project-verified migration workflow. Verify service-only execution and
   admission from two separate PostgreSQL connections. A denied admission must
   complete promptly, and a new transaction must succeed after release.
3. Confirm current memory, CPU, swap, disk, connection activity and API role
   statement/idle-transaction limits. Function configuration alone is not
   evidence that an enclosing SQL call has a hard execution deadline.
4. Verify signed-session authorization and receipt context, search, client
   details, inbox and private photo upload with cleanup. Recheck suspension
   denial using existing tests or a rolled-back probe. Do not create committed
   test financial records or manually send Telegram messages.
5. Let the finite pause expire or remove it through a fresh deployment. Check
   ordinary scheduled work, queue progress and resource health after resumption.
   Ongoing inability to connect requires database administration, even if the
   application build and middleware checks pass.

Local regression coverage includes expiry and authentication of the pause,
private-screen withholding and reconnect, already-approved receipt processing
during automatic-approval failure, SQL defaults and grants, and denial before
original SQL side effects. PGlite tests validate SQL integration; production
cross-connection lock contention and live availability require separate checks.
