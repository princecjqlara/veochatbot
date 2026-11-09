# Calendar earnings, order reporting and reliability plan

Status: implemented with the proposed defaults. See
`veo-calendar-earnings-release.md` for the delivered behavior and verification.
The new VEO project remains the single database; the fresh-start policy,
existing tagging and restored chatbot setup are preserved.

## Findings and proposed defaults

- The deployed release has 134 verified migrations and 115 public tables.
  Schema installation alone does not establish that every external integration
  or user workflow works.
- The calendar already calculates daily completion revenue, actual commission,
  ad spend and net. It has no month-level daily earnings averages. Its current
  `gross_minor` value already includes refund deductions, so adding new gross
  labels requires an explicit ledger mapping to avoid deducting refunds twice.
- Calendar date changes currently reload the month inputs and finance data.
  The loader uses up to two Page reads at once and retries/splits timed-out
  ranges. These protections should remain while repeated work is reduced.
- The local, uncommitted Meta order-status feature includes application changes
  and migration `202611080015_veo_meta_order_submission_gate.sql`. It changes
  receipt eligibility as well as storing order statuses. It needs review as a
  complete feature before deployment; the migration must not be applied alone.
- Six recovered members still need login emails/passwords. Eight saved Page
  connections need current-app credentials and AIkita lacks a saved connection.
  Ad-account access and spend coverage need verification before complete net
  figures can be claimed. These are separate from migration completeness.

Unless the owner chooses different definitions, average/day includes every
elapsed Philippine calendar date in the selected month from the fresh launch
date, including zero-sale days. Future dates and dates before the fresh launch
are excluded. Today and averages including today are provisional. A month with
no eligible days displays no average, rather than dividing by zero.

Net keeps the current scope: verified completion revenue after refunds, less
actual employee commissions and recorded ads. Other operating expenses and
taxes are excluded and must be stated. Adding those costs would require an
explicit recorded-expense workflow and a revised formula.

## 1. Establish the schema and feature baseline

1. Compare the deployed code's migration manifest with the new project's
   receipts; check required tables, columns, views, functions, foreign keys,
   indexes, role permissions and private storage.
2. Map each feature to its UI, endpoint, database objects, worker and external
   dependencies. Track working, needs repair and needs credentials separately.
3. Cover sign-in and recovered accounts, Page scope, chatbot/knowledge, tags,
   contacts and identity sync, orders/payments/refunds, receipts, calendar,
   salary/capacity/budgets, ad spend, Telegram handoff and background jobs.
4. Review the existing local order changes without overwriting other pending
   work. Keep current receipt rules unless a deliberate policy change is agreed;
   reporting Order Created does not itself require tightening Closed Deal rules.

## 2. Add Calendar earnings summaries

Add a month summary above the calendar, following the selected Page/branch and
currency. Show total and average/day for completed gross revenue, refunds and
net after commissions and ads. Show actual commissions, recorded ad spend,
verified cash received, reporting dates and the denominator alongside them.

Reconcile gross before refunds from the authoritative verified-payment ledger
for completed orders. Compute refund-adjusted revenue once, then subtract the
existing authoritative commission and ad costs. Preserve the current recognized
completion-day basis and label late-refund adjustments through report time.
Cash received follows payment dates and is presented separately. Deposits and
balances for the same order must never create two completed sales.

Calculate the summary from the same complete daily data used for the calendar,
with integer minor currency units and display-only rounding. Keep currencies
separate. Distinguish a proven zero from missing information. Show cost coverage
and the reason net is unavailable; incomplete days must not silently disappear
from the denominator or become zero-cost days.

Start with the selected month, its elapsed dates and a single shared formula.
Custom multi-month ranges, if added, must use the same definitions and automatic
date chunking rather than asking users to shorten a report to fit one request.

Primary code: `src/lib/veo-calendar-analytics.ts`,
`src/components/VeoWorkCalendar.tsx`,
`src/app/api/workspace/calendar/route.ts` and any minimal additive SQL projection
needed to expose gross/refund components accurately.

## 3. Complete Order Created reporting and reconciliation

Show distinct orders created, their value and unpaid balance for each date and
the selected month. Use the actual source creation timestamp in Asia/Manila,
not the date an old invoice was imported. Separate the contact's lead stage
from the invoice's Created/Ordered/Paid status and from verified payments.

Validate which statuses Meta actually exposes. Match the invoice, Page, client,
source message, actor and event time. Missing or partial evidence remains
unknown. Customer prose or an image cannot establish verified financial payment.
Review the pending status parser for forged notice text and cross-invoice
confusion before making it an eligibility authority.

Exercise create/import, link, deposit, balance, full payment, refund, receipt
check/save and handoff as one workflow. Repeated imports, retries, refreshes and
lost responses must preserve a single invoice/order/payment. Partial scans must
continue from saved cursors and reconcile newer status evidence with an invoice
already saved in an earlier batch.

## 4. Reduce load and control storage growth

- Reuse monthly data when only the selected day changes; load expensive detail
  separately when needed. Coalesce identical requests and cancel stale ones.
- Cache permitted report aggregates for a short, explicit period, keyed by
  tenant, actor scope, Page filter, date range and currency. Recheck current
  access before serving cached data. Refresh after relevant ledger changes.
- Measure actual query plans and timings, then add only useful indexes and
  avoid repeated full contact scans. Calculate averages from existing results
  without copying financial rows into another history table.
- Audit cron coordination across serverless workers. Use database leases,
  idempotent queue items, due-job selection and resumable cursors; a warm-worker
  in-memory lock alone does not coordinate every instance.
- Keep controlled concurrency, pooled direct SQL connections, request deadlines
  and outage backoff. Apply pooling to the appropriate SQL client, rather than
  confusing REST API calls with direct database connections.
- Process all queued records over bounded batches. Pagination and continuation
  must expose the complete dataset rather than imposing a total-record cutoff.
- Measure database/table/index size, available disk/WAL headroom, active
  connections, query latency, timeout rates, queue age and retry counts. Reuse
  existing observability where possible rather than storing every poll forever.
- Verify existing temporary-payload/photo cleanup and prevent duplicate profile
  archives. Preserve contacts, tagging, knowledge and financial audit records.

Provider capacity and rate limits remain real. The objective is predictable
progress and responsive interactive requests on the existing plan. Universal
zero-error or unlimited-throughput guarantees are not a release criterion;
recoverable failures must be explicit, bounded and safe to retry.

## 5. Verify and release

Use isolated fixtures for financial writes and load tests. Cover zero sales,
losses, first-day launch, partial months, Philippine midnight boundaries,
provisional today, refunds recorded later, exact commissions, missing costs,
multiple currencies, multiple invoices per client, partial scans, duplicate
events, concurrent workers, timeouts and revoked Page access.

Require month totals to reconcile with daily totals and the authoritative ledger
to the centavo. Verify that the averages reuse those totals and the displayed
day count. Existing role and Page restrictions must pass for all four roles.

Run the related calculation, SQL migration, route, UI, order/receipt and worker
checks, TypeScript and the production build. Compare query counts and timings
with the baseline using documented datasets and concurrency. Heavy synthetic
traffic must not run against the live database.

Apply only reviewed additive migrations to the new project using the verified
installer and consistent receipts. Deploy the matching application code, then
perform live sign-in, Calendar/filter/read checks and queue-health observations.
Report tested features and unresolved credential/provider dependencies
separately. Keep the previous application deployment available for rollback.

References: [Supabase query optimization](https://supabase.com/docs/guides/database/query-optimization),
[connection pooling and limits](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits),
[Meta Conversations API](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a).
