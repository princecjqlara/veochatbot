# Jaucian client controls, November 15, 2026

The live audit found that workforce verification returned HTTP 400 while the
delivery scheduler remained healthy. Jaucian's PostgreSQL adapter accepted the
poll relationship only as `daily_polls!inner(work_date,chat_id)`, but workforce
verification selected the same two fields in the opposite order. The adapter now
accepts both. Regression coverage compiles every actual workforce query through
the production adapter. The normal scheduled workforce sync recovered after the
release, with fresh confirmed human membership and no staff departure recorded.

The Telegram client list also offered direct Accept and Offer controls for
clients waiting in the automatic queue or still missing three valid intake
answers. These clients now show their waiting or collection status. Delivered
offers retain their recipient-bound acceptance buttons, current Page and group
checks, acceptance deadline and single assignment result.

Ready, Busy and navigation tokens previously reused the first click's result.
They now process each new Telegram update, while retries of the same update and
repeated assignment mutations remain idempotent. Acceptance returns an explicit
confirmation. Spaced bot mentions work for `/ready` and `/busy`. Known assignment
policy errors reach the user instead of becoming a generic menu failure. Retained
literal newline escapes in client menus are normalized.

Validation: all 1,389 Jaucian tests and 104 related VEO SQL/API tests passed.
TypeScript checking and both production builds passed. The SQL release preflight
and installation preserve existing assignments, tokens, sales, grants, accounts
and launch dates; the function remains private. Live checks verify HTTP 200 for
workforce and health, current scheduled sync, and usable multiline menus. Live
menu rendering is rolled back; no test Telegram message or manual dispatcher is
invoked. Real staff acceptance is covered by the SQL regression test rather than
claiming a production client for testing.

Use `/clients` for a fresh personal menu and `/offers` for the current offer.
Ready/Busy controls and new menus reflect the current policy. Existing expired
menus remain expired; queued clients still follow the automatic rotation and
detail requirements.

Release and verification receipts are in ignored
`.vercel/telegram-client-controls-*.json` files. The release script supports
`--preflight` and `--apply`; `scripts/verify-telegram-client-controls.mjs` reads
existing production state and rolls back its menu render. Its optional
`--auth-env` argument selects current service authentication separately from the
local PostgreSQL connection.

## Follow-up live check, 01:04–01:15 UTC

The follow-up found intermittent HTTP 503 responses from VEO's assignment and
directory endpoints. Workforce sync had stopped refreshing after 00:33 UTC.
The signed-in client context also returned HTTP 503, and direct database reads
and the provider metrics endpoint later timed out. Some ordinary dispatcher
runs succeeded between failures, with no failed or overdue saved deliveries;
that alone does not establish working client acceptance or offer retrieval.

The verifier now requires a successful live pending-offer response as well as
workforce, sync and menu checks, and retains dated verification results.
The earlier successful release checks are a point-in-time result, not proof
of continued service availability. No database restart, permission change,
manual dispatch or staff/client reassignment was attempted in this audit.

## Recovery and delivery repairs

Concurrent requests from an older failed batch could restart the API cooldown
after a successful recovery probe, or extend its backoff for each delayed
response. The availability gate now fences failures by their starting generation
and advances that generation after recovery. Tests first reproduced three such
failures, then passed with the repair. Writes still make one attempt; no failed
mutation is blindly replayed.

Jaucian now requires `acknowledged: true` from VEO before completing an offer or
inquiry notification. A negative or missing acknowledgment retries its saved
checkpoint, retaining the Telegram message ID and original delivery time and
avoiding another Telegram send. Its public health check reads the authoritative
pending-offer endpoint even when the local outbox is empty. The fifteen-second
probe permits VEO's twelve-second deadline and transport time.

Pending-offer failures now include retry guidance and preserve their underlying
error for server diagnostics. Logs include only a sanitized error code, excluding
private database messages. Existing regression fixtures were updated for the
current independent order check, supervisor-only receipt deletion, inquiry-date
calendar default, missing-cost wording and staggered ads schedule. Financial
calculation and staff permissions were not changed by those fixture updates.

Workforce synchronization now runs independently before receipt cleanup and
salary maintenance. Failures in those unrelated steps still report HTTP 503,
but cannot prevent editor membership and eligibility from refreshing. A failed
Telegram sync also leaves cleanup running. Regression cases cover both failure
directions without invoking a production dispatcher.

Final local validation covered 1,391 Jaucian cases and 2,435 VEO cases across
318 suites. The parallel VEO run's four failures were resolved with an isolated
13-case run: two resource-sensitive test timeouts passed without increasing
their deadlines, and the two new workforce cases passed after the maintenance
ordering repair. TypeScript checking passed. Ignored validation logs retain the
full run and focused reruns; the code does not claim these checks establish
continued availability of the external database service.
