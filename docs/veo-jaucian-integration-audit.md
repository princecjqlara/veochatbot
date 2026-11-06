# VEO and Jaucian integration audit — November 6, 2026

VEO owns the verified financial ledger. Jaucian retains the existing Telegram bot, approved VEO destinations, observed Telegram identities, delivery outbox and archived group history. Each server can now read the other service's necessary data through authenticated, tenant-bound APIs. Database administrator keys remain private to their own service. There is no second writable copy of sales or salary data to reconcile.

## Commission

A worker, including a selling manager, earns **40% only when both personal Closed Deal and Done Deal targets are met** for the Philippine work date. Otherwise the rate is **35%**. Each personal target is the frozen capacity target, with minimum/default 1. Reaching a team quota does not qualify a worker who missed a personal quota. The final daily rate applies to every fully paid order total attributed to that worker on that date; earnings remain provisional until Philippine midnight. Retained history is excluded, and refunds/corrections retain audited adjustments. No payroll transfer or manager override commission is introduced.

The database tests cover a carried deposit with a balance today (Done without Closed today), personal Closed target reached while Done remains short (35%), and the later balance reaching both targets (40% across the entire day's fully paid totals). Existing tests cover a team reaching its quotas while an individual stays at 35%.

## Shared data and setup

| Direction | Shared data and controls |
| --- | --- |
| VEO → Jaucian | Authenticated eligible-order handoff; current Converted status, verified settlement, attribution, page access and expiry checked before forwarding; short-lived private photo URL. No image bytes in the database. |
| Jaucian → VEO | Tenant-bound approved active VEO group directory, observed identity candidates, known topic IDs and the latest 50 VEO outbox states. Arbitrary messages, signed photos, Suno data and credentials are excluded. Identity lists explicitly have limited coverage. |
| VEO → Jaucian | Tenant-bound active workforce/team/page directory, explicit numeric Telegram mappings, current/tomorrow declarations and the commission policy. No passwords, email addresses or Page tokens. Jaucian checks the reverse connection and reports missing mappings. |
| VEO → Jaucian | Authoritative per-day worker commission, personal/team quotas, capacity averages and tomorrow's participation through the existing report endpoint. The older Jaucian daily-summary URL also reads this verified ledger in workspace mode. Telegram receipt parsing cannot create a second VEO sale. |
| Mapping writes | Owner only, same-origin and audited. Team destinations must be approved in both systems. A worker's numeric Telegram ID is checked with the existing bot's `getChatMember` for current human membership in that worker's mapped team group. User-entered usernames never automatically bind identities. |

Owner **Accounts & Teams → Jaucian connection and Telegram setup** shows both connection directions, missing mappings, known groups, identity suggestions, existing mappings and delivery states. Map each real application team to its approved Jaucian group, then choose each matching person. Group titles or usernames alone cannot safely identify which newly created account belongs to which existing Telegram identity, so mappings are not guessed.

The read-only production audit at 07:39 UTC found 6 workspace accounts, 15 enabled VEO Pages, 0 orders, 0 mapped teams and 0 mapped workers. No anonymous application table/function access was exposed. Jaucian's regular database scheduler and watchdog were healthy with no failed, stale or overdue deliveries. No test Telegram message, fake sale or historical backfill was dispatched. These counts are a point-in-time observation; staff can continue editing the live workspace.

## Differences from the older Jaucian workflow

| Older capability | Current VEO behavior / remaining gap |
| --- | --- |
| Telegram photo/receipt text counted as sales | Replaced by verified VEO orders and payments. Archived receipts never increase new quotas or salary. |
| Telegram availability and page-access polls | Implemented in the staff operations release: verified mapped tomorrow votes import with timestamp/update-ID fencing and audits; Page declarations are shown for supervisor review and never auto-grant permissions. |
| Ready queues, automatic round robin offers, freebie assignments, referrals and missed-offer warnings | Preserved as archived Jaucian code/history, excluded from the active VEO workspace dispatcher. These workflows do not currently exist in the new workspace. Re-enabling them would require adapting them to current Page permissions and the launch cutoff. |
| Legacy forecasting and production/workload planning | New individual capacity, team quota, combined/average capacity and tomorrow's roster are implemented. Older speculative forecasts and workload-based warning policies are not imported as verified results. |
| Large Telegram team reports | Implemented in the staff operations release: three daily snapshots, fixed multipart manifests, independent acknowledgments and current permission checks before each part. |
| Uncertain Telegram acknowledgment | Delivery is held for reconciliation to avoid a duplicate post. The connection panel exposes the hold; automatic blind resend is suppressed. A dedicated review/action UI is still absent. |
| Facebook login/connect | Removed by the user's later instruction. CJ retains the existing Owner identity with email/password sign-in. Retained VEO Page tokens and webhook collection continue. New Page reconnection is not available in this email-only workflow. |

No direct cross-database administration is needed for coexistence. Each service writes its own records and reads the necessary authoritative data through the existing shared secret. Launch/archive boundaries and Suno deactivation remain in effect.

## Collection throughput correction

The live audit also found a growing inbox: 2,185 pending events, the oldest 33 minutes old, with 343 arrivals in five minutes. The worker previously claimed one batch of 20 per scheduled run. Successive serial batches increased throughput but still fell behind live arrivals. It now drains successive small leases with four separate conversations in flight, up to 200 attempts or the existing 210-second processing budget, then leaves time for private-photo handoffs.

Migration `202611050019_veo_conversation_event_leases.sql` derives a shared conversation key for a client's inbound, Page-echo and standby events. The database leases only the oldest unfinished event for each conversation, including across simultaneous cron runs. A failed or busy event blocks later events only for that client. The worker also keeps duplicate conversation keys serial within a lease, releases unstarted events at the deadline, and retains attempt-fenced acknowledgment, deduplication and delayed retries. No historical import or manual dispatcher call is involved. Regression tests cover conversation ordering, lease expiry, retry blocking, multiple batches, bounded parallelism, the attempt cap and deadline release. Observe recovery through ordinary scheduled runs after deployment.

## Verification and release

The 16 VEO SQL tests and 52 related authentication, permissions, directory, mapping, route, worker and UI tests passed. The final full VEO run passed **all 1,469 tests in 182 files**. The six previously failing calendar assertions were updated to verify the existing recorded/provisional reporting behavior, complete confirmed-payer fixtures, and timezone/coverage flags; no calendar or commission calculation was changed. The VEO production build passed. Jaucian's required `py validate_project.py` passed **all 1,295 tests**; its deployment gate now requires `test_veo_directory.py`. The API bridge requires no environment-secret change. Migration 019 was applied before deploying the parallel event worker, and preserved all 41 identities, 52 Page grants and 658 retained payments. The launch cutoff was unchanged. Verify both service directions using `node --env-file=.env.local scripts/verify-veo-jaucian.mjs`, plus production health and the normal scheduler, without invoking delivery manually. This verification reads databases/APIs only and does not print tokens, personal directory entries or credentials.

The production connection check at 07:54 UTC succeeded in both directions, rejected anonymous access and a signed-in non-Owner, and found six approved VEO groups with 183 observed identity candidates. It confirmed the same 40%/35% personal commission policy in both services. Three application teams and three selling workers still needed explicit mappings. The probe created no sales, mappings, photos or Telegram messages. The workspace production probe also verified searchable contacts (49,930 visible), all 15 retained Page connections, default team capacity, email-only authentication, archive/Suno boundaries, the Telegram profile prompt and Owner calendar/ads reports.

After the final worker deployment, normal scheduled collection cleared the backlog. At 08:16 UTC there were **zero pending events, zero processing events, zero recorded errors and zero conversations with multiple active leases**. The recovery probe observed 1,032 completed events since its 08:10 baseline. The connection and workspace production probes passed again on the new deployment, and Jaucian's ordinary scheduler/watchdog remained healthy with HTTP 200 and no overdue, failed or stale deliveries. Production delivery of a real sale remains unexercised because the real team/worker mappings have not yet been selected. Interactive visual browser QA remains unavailable in this environment; UI rendering tests and authenticated HTTP checks provide the recorded coverage.

## Staff operations release

See [staff operations, salary, budgets and Telegram policy](veo-staff-operations.md) for migrations 020?024, audited removal and client takeover, actual daily salary/calendar totals, shared Page capacity and budget rules, rankings, deadlines, tomorrow polls and confirmed-departure reconciliation. The earlier verification counts above describe the preceding release; the latest release receipts are produced by the verification scripts.
