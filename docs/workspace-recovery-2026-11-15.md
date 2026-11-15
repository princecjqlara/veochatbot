The signed-in dashboard reproduced HTTP 400 with a Supabase timeout while
profile context succeeded and another context request received HTTP 503.
Database connectivity also varied between successful reads, query timeouts
and connection authentication timeouts. These observations do not establish
continuous availability of the upstream service.

Report reads now recognize SDK transport errors returned as plain result
objects, wait for the recovery cooldown before retrying, and preserve their
overall deadline. An already open circuit still fails immediately for new
requests. Explicit report reads use their existing eighteen-second budget
instead of being interrupted by the transport's ten-second default. Ordinary
writes retain the default deadline and are never automatically replayed.

Dashboard and client-assignment outages return HTTP 503 with retry guidance.
Initial workspace loads retry temporary server or network failures after
thirty seconds; access denials do not retry. Current permission checks still
run for each request. Failed reports remain visibly unavailable.

Migration 202611150002 removes availability, navigation and handover buttons
from newly rendered Telegram replies. Editors use /ready and /busy. Fresh
inquiry announcements have no buttons; offered clients retain exactly Accept
client and Remove from list. Removal declines the current editor's offer and
preserves the client for reassignment; it does not delete the client. Existing
automatic rotation, acceptance deadlines, ownership checks and idempotency
remain authoritative. Older messages already in Telegram are not edited.

The SQL wrapper is tested with PGlite for keyboard filtering, mutation
forwarding, authority denial, private execution privileges, ended notices and
legacy handover instructions. Live installation uses the reviewed migration
runner's project verification, rollback preflight and preservation inventory.

Validation: 75 focused VEO cases across ten suites passed, the production
Next.js build passed, and Jaucian's full 1,393-case validator passed. The
production migration was applied at 13:49 UTC after a successful rollback
preflight; existing data and private execution privileges were verified.
The 13:50 UTC live pending-offer probe still returned HTTP 503. Code and schema
validation therefore do not yet demonstrate full production recovery.

Further hosted diagnostics showed widespread PostgreSQL statement timeouts,
including the database's own monitoring exporter. The saved resource sample
reported five-minute load 10.5 on two CPUs and 455 MB total memory; fresh
monitoring was unavailable. The database occupied approximately 294 MB.
These are observed service-resource limits, not proof that every timed-out
query has the same cause.

The existing pressure guard now also defers scheduled quota recalculation,
stage-history repair, and optional workspace planning/maintenance/enrichment.
The workspace worker keeps eligibility sync, receipt expiry cleanup and
submission delivery; the independent live-event and editor-dispatch workers
continue. Paused work is explicitly reported and resumes through ordinary
scheduled runs once resource checks permit it. No cron schedules were changed.
An additional 28 focused cases passed, including an actual mocked submission
being checkpointed for retry while optional work is paused, normal editor
dispatch, the independent event worker and resource-monitoring validation.

The overloaded Supabase service was restarted once through the authenticated
Management API. PostgreSQL confirmed its new start at 14:27 UTC. At 14:30 UTC,
pending offers, verified workforce and Jaucian health returned HTTP 200;
ordinary workforce synchronization had resumed. The recorded five-minute load
fell to 0.7, with fresh resource monitoring available again.

Dashboard and capacity calculations completed independently in approximately
six and three seconds. Running them concurrently still caused the signed-in
dashboard to time out. The route now performs those calculations sequentially,
preserving all financial results and permission checks, and stops immediately
if the preceding report fails. A regression case holds the dashboard response
open and verifies that capacity does not start until that calculation finishes.

A later live read completed in 7.9 seconds, leaving insufficient headroom under
the inherited eight-second database limit. Migration 202611160001 sets only
the dashboard and capacity RPC limits to fifteen seconds, below the existing
eighteen-second application read deadline. Function bodies, owners, execution
privileges, assignment mutations and financial calculations are unchanged.

Further profiling isolated unused order and collection lists in the dashboard
query: a rollback probe excluding those lists completed in 3.8 seconds. The
workspace already replaces the order list with its paginated query and loads
collection health through its dedicated view. Migration 202611160002 adds a
private summary RPC derived from the current full dashboard, omitting only
those unused lists. The full RPC remains available. A financial SQL regression
compares all remaining fields after an approved Close and Done Deal, verifies
member scope and execution privileges, and checks that full order history is
still returned by the original report.

The summary migration passed its production rollback preflight and was applied
at 19:33 UTC with original function bodies, permissions, records and accounts
preserved. The corrected route then returned HTTP 200 against the production
database in 6.5 seconds, including capacity, accounts and salary data. All 41
financial SQL cases passed, along with the eleven workspace route cases.
Two unrelated test timeouts during a concurrent production build passed their
isolated reruns without changing test deadlines.
