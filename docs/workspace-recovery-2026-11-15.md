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
