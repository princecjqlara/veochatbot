# Member receipt recovery: 18 November 2026

At 13:58 UTC the production database was reachable again. PostgreSQL reported
a service start at 11:08 UTC. This session did not initiate that restart.
Troy's signed session, receipt context and review inbox returned HTTP 200.

Troy passed all three real private-photo uploads and Close Deal/Done Deal save
validation with idempotent retries on all four permitted Pages. Save probes
used rolled-back transactions; the temporary images and metadata were removed.
Two HTTP Submit retries used Troy's own existing delivered Close and Done Deal
receipts. Both returned HTTP 202 with the same review, `duplicate: true` and
`delivery_dispatch.state: delivered`. Existing receipt, order and payment
records were compared before and after. No new financial record or Telegram
send was needed for these checks.

The single-worker audit covered all 50 active members and 85 member/Page
assignments. Its first pass succeeded for 49 members. JD's client-details read
temporarily returned HTTP 503; a separate fresh read then returned HTTP 200.
That failure exposed a recovery gap in the receipt form: a failed client load
had no explicit retry action. The initial audit removed all 147 uploaded test
photos. JD then passed the original client read, all three live uploads and all
six save/retry probes across the same three Pages. The combined result is
**50/50 active members**, 85 member/Page assignments, 170 rolled-back save
probes with idempotent retries, and 150 temporary uploads removed. No test
review, order, payment or Telegram send was committed.

The form now offers **Retry client details**, retaining entered amounts and
selected photos. Cancelled responses cannot replace the newly selected client's
details. Retrying reads current permissions and orders and does not submit a
sale automatically. Temporary contact/financial read failures return HTTP 503
with retry guidance; missing Page access remains HTTP 403. The receipt build
gate now includes these route and form regressions.

The pending shared background SQL admission migration `202611180001` passed a
rollback preflight and was installed at 13:59 UTC. Original function properties,
service-only grants and existing operational records were verified. Separate
PostgreSQL clients confirmed that a competing transaction receives `55P03`
promptly and admission succeeds after rollback releases the lock. Heavy jobs
defer instead of competing concurrently; interactive authorization and receipt
intake do not acquire this lock.

At 14:00 UTC file Storage contained approximately 20.3 MB across 68 remaining
receipt objects. All 144 photos associated with delivered reviews were marked
removed, and the live cleanup endpoint returned HTTP 200. PostgreSQL was
approximately 361 MB with 1.38 GB available on the data disk. These are separate
measurements. The app's database budget warned at this size, but receipt intake
remained permitted. These readings do not establish an organization-wide quota
or explain every earlier provider outage.

At 14:12 UTC a direct join to `storage.objects` confirmed zero remaining stored
files for all 144 delivered evidence photos. Fresh monitoring reported no
resource pressure and healthy maintenance. All 129 focused receipt, accounting,
route and form regressions passed, together with source type checking.

The audit uses signed identities and current account/Page permissions, not
members' passwords or their actual devices. A profile confirmation or verified
Telegram identity link remains a member setup requirement where applicable.
The audit does not manufacture these confirmations or links.

Private evidence: `.vercel/all-member-receipt-audit-2026-11-18-combined.json`,
the preserved initial audit and successful recheck,
`.vercel/troy-receipt-http-replay.json`, `.vercel/receipt-current-diagnostics.json`,
`.vercel/background-capacity-apply.json`, `.vercel/background-capacity-contention.json`
and `.vercel/receipt-photo-live.json`.
