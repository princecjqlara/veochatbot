# Calendar earnings and database reliability

Calendar now includes monthly completed revenue, refunds, actual commissions,
ad spend, net profit/loss and average gross/net per calendar day. The denominator
includes elapsed Philippine dates since the fresh launch, including zero-sale
days. Future and pre-launch dates are excluded. Today is provisional.

Gross before refunds comes from verified payments on completed orders. Refunds
are deducted once; net then subtracts actual commissions and ads. Later refunds
update the original completion-day result through report time. Cash received
uses payment dates, so a deposit and balance do not become two completed sales.
Other expenses and taxes are excluded. Currencies stay separate. Missing costs
prevent a complete net average and show the number of affected days.

Orders Created shows distinct recorded invoices/orders on their actual source
creation date, their value and known outstanding ledger balances. Linking a
Facebook invoice to an existing order does not count it twice. An unlinked
invoice has an unknown payment balance, and order creation never establishes
revenue or payment. Existing receipt eligibility rules remain intact.

The uncommitted `202611080015_veo_meta_order_submission_gate.sql` and its separate
local receipt changes were reviewed and excluded. They tighten Closed Deal
requirements and treat parsed status notices as eligibility authority. This
release implements order reporting without introducing that policy change.

## Database work and request load

- Migration `202611090005` adds gross/refund ledger components, source-dated
  order reporting, and a separate authorized day-detail function.
- Monthly reads share a small, 30-second warm-worker cache. Day details use a
  15-second cache. Every request rechecks live access; cache keys include tenant,
  actor, role, Page grants, branch identities and the current Philippine date.
  Refresh explicitly reloads the results and overlapping reads are coalesced.
- Selecting another day reuses the monthly inputs instead of repeating the
  month-wide read and finance preparation. Day reads use at most two concurrent
  Page requests. Failed pieces cannot become apparently complete zero totals.
- Migration `202611090006` adds shared cron leases for workspace maintenance and
  contact-profile jobs. Different server instances cannot duplicate a long run.
  Queue-item leases still protect individual events and deliveries. Crashed
  workers recover after the lease expires; no contact/order count is discarded.
- Migration `202611090007` indexes the existing seven-day processed-payload
  cleanup and bounds selected-day sources to their reference window. Cleanup
  preserves event deduplication keys, financial records and archive records.
- Migration verification accepts LF/CRLF representations of the same SQL without
  changing saved receipts. Changed SQL and wrong-project fingerprints still fail.

The database remains `mjuluaqrvbnycisnarzi`. No dual-database configuration or
transfer of financial authority to the failed old project was introduced.

## Verification and operational dependencies

Targeted checks cover Calendar calculations/UI/routes, all-migration installation,
gross/refund reconciliation, source dates, invoice deduplication, Page revocation,
private RPCs, lease ownership/expiry, receipt rules and recovery backoff. All 86
receipt regressions pass. TypeScript passes. An isolated calculation fixture with
100,000 completed orders reconciled in about 144 ms on the local machine; this
is a calculation benchmark, not a production database load test.

`scripts/verify-veo-feature-readiness.mjs` performs a read-only inventory from a
clean release checkout. The new database has 137 verified migrations and 116
public tables. Required feature objects, private recovery functions, valid
indexes and the private photo bucket were checked. Ignored release receipts
remain under `.vercel/veo-earnings-release/`.

Schema readiness does not supply missing credentials. At verification, six
recovered members still needed login details, and ad-spend coverage had no
records. Previously identified Page reconnections and Telegram mappings need
their own operational verification. Financial fixtures and synthetic scale
checks ran in isolation, without creating real sales or sending customer or
Telegram messages.
