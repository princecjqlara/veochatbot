# Acquisition-day calendar and creative economics

Ad Calendar & Profit groups leads by their first inquiry date in Asia/Manila.
The same day retains its cohort after midnight or month end. Current stage
conversions, later conversions, verified first receipts and lifetime recorded
cohort revenue update that original day. Filters support month, authorized Page
and originating ad. A selected day has timing buckets and paginated contact links.
Unknown sources have a separate view and receive no allocated advertising spend.
The contact Sources view links each referral to the corresponding ad/calendar day.

The calendar opens on total inquiries, including unknown-source inquiries when
all creatives are selected. The total does not double-count the unknown-source
filter. Financial attribution remains separate: unknown inquiries receive no
guessed ad spend. The date grid appears above the financial cards and stays
visible during loading or a report error. Missing profit has an explanation and
a shortcut back to inquiry counts.

Previous, Next, This month and the month picker browse months from 2000 through
2099, including future months. Future dates show unavailable actual results and
remain disabled; future-month ad-spend imports are disabled too. An incomplete
month-input edit retains the current valid month.

The calendar uses the dashboard's connected-Page list and opens one Page at a
time. It selects the first connected Page unless a connected Page is specified
in the link. Disconnected Page links fall back to a connected Page and clear the
old creative filter. No combined all-Page report is requested by the calendar.
If no Pages are connected, the date grid stays unavailable with a connection
link. Page-list failures can be retried without issuing an unscoped report.

The heat map can show spend, inquiries, stage conversion rate, verified payers,
payer rate, CPA, cost per Meta conversation, profit, gross ROAS and net ROAS.
Profit uses diverging gain/loss colors. Unavailable data stays gray. Daily cells
also show ad spend, linked inquiry count and confirmed customers across the
selected sources, including unknown ad origins. Current pipeline stages remain
separate from customer confirmations. Future days are
disabled and today is provisional. Larger values have stronger colors; expensive
acquisitions are not labeled better just because they are darker.

## Counts and attribution

The overall calendar includes all inquiries and outcomes, including unknown
origins. It deducts the imported Page ad spend once from recorded overall cash.
Creative rows keep their verified first-origin cohorts; unknown-origin receipts
are never distributed to an ad. Overall CPA is therefore a blended cost, while
creative CPA is specific to that ad's documented customers.

Confirmed customers combine existing conversation-documented Page payment
acknowledgements with ledger-verified payers, counting an overlap once. The first
confirmation and later-day timing remain attached to the original inquiry day,
including confirmations after month end. Conversation review coverage and newer
activity are shown. A confirmation supplies a customer count and timestamp, not
a verified monetary amount. The evidence button reopens the exact Page-authored
message and checks its author, timestamp and payment meaning before showing it.

An Order Created stage retains an earlier documented Converted stage. A direct
order without that earlier conversion remains an order count. Negative or
reversed stages are not silently treated as current Converted stages.

Missing Meta report dates are imported automatically once the current user has
connected ad-account read access. Only complete authorized ad/week reports can
produce saved zero days; failed or inaccessible reports remain unavailable.
No advertising budgets are changed.

Stage conversions count the cohort's current `converted` stage, retaining it
through a later Order Created notice when the earlier conversion is documented. A documented
stage transition supplies timing; missing timestamps are not guessed into a
same-day bucket. Stage reversals affect current counts. Stage conversions do
not establish payment. Verified acquisitions count unique contacts with a
non-void positive verified receipt, after inquiry and through the report time.
Deposits and balances are not separate acquisitions. Refunds reduce revenue
without erasing acquisition history. Timing buckets use PHT calendar days.

The inquiry range selects contacts, not payment dates. SQL reads later outcomes
and receipts without clipping them to the inquiry month. One contact appears once
before currency-specific finance aggregation, preventing payment-join fanout.
Sources come from existing verified first-origin evidence; later clicks get no
automatic revenue credit. This is first-origin cohort lifetime reporting, not
Meta's platform-attributed purchase ROAS. Legacy dates, unknown origins and Page
synchronization errors remain visible. Receipts before the known inquiry are
excluded and flagged for date review.

## Revenue, salary and returns

The default basis is verified cash received, including deposits and balances,
minus refunds. Missing payment records remain unverified; they are not turned
into zero revenue or an unpaid assertion. Recorded returns can understate the
business's true returns if its ledger is incomplete.

- Recorded revenue = verified receipts minus verified refunds.
- Salary allowance = 40% of positive recorded revenue per acquisition-day/creative
  cohort, added across cohorts. Refund-only losses do not invent payroll credits.
- After-salary return = recorded revenue minus that allowance.
- Profit after salary and ads = recorded revenue minus allowance minus ad spend.
- Gross ROAS = recorded revenue / ad spend.
- After-salary ROAS = after-salary return / ad spend.
- Net ROAS = profit after salary and ads / ad spend.
- Verified CPA = ad spend / unique verified cohort payers.
- Stage conversion cost = ad spend / current Converted-stage leads.
- Cost per linked inquiry = ad spend / verified-origin cohort inquiries.

The allowance is a modeled cost, not payroll verification. Other expenses and
taxes are excluded. Division by zero produces N/A, not infinity. Currencies are
kept separate and no exchange rate is invented. Currency conflicts, incomplete
ad-day spend or incompatible account day boundaries block combined profit/ROAS.

## Actual spend and delivery import

Read-only Facebook `ads_read` access is requested explicitly from the calendar.
The import first updates verified Page/ad inventory, then reads bounded batches
of at most 20 ads × 7 reporting dates. Each Insights batch is fully paginated
before one atomic upsert. A missing/repeated cursor, invalid account/currency,
duplicate ad-day breakdown or incomplete request publishes nothing for that
batch. Failed batches can be continued; completed batches remain saved.

An absent ad-day row is marked reported no activity only after the entire
filtered Insights response completes. Unimported days are never zero-filled.
Amounts cover the imported inventory verified for the authorized Pages; unknown
ads are not assigned by name or proportional budget. Account timezone is retained,
and PHT cost ratios require matching real day boundaries. Meta can delay or revise
reports, especially today. Spend is actual reported delivery cost, not a planned
campaign budget. No campaign budgets or customer messages are changed.

Delivery fields include impressions, all/link clicks, reach (ad-day only), Meta
messaging conversations started, video plays, ThruPlays and complete video plays.
CTR, CPC, CPM, frequency and cost per messaging conversation are derived only
when their denominators and complete spend are known. Reach is not summed across
ads/days into a fake unique audience. Meta conversation actions are kept separate
from unique VeoBot inquiry cohorts. Actions use conversion reporting time and
the ad sets' attribution setting; no unrelated action types are added together.

Primary API reference: [Meta Insights fields and enums](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adsinsights.py),
[Meta ad-account Insights parameters](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py).

## Release and checks

Historical first-inquiry and stage reconciliation runs independently of AI
summaries. See [the deterministic repair workflow](historical-data-reconciliation.md).
Late authenticated notices retain their historical conversion times even when
they did not overwrite a newer local pipeline decision.

Large historical cohorts use indexed contact/date reads, one payment aggregation
per report, and name/PSID lookups only after the contact list is paginated.
The finance aggregate is materialized once; it is not recomputed for each
day/creative group. Calendar functions disable their own JIT compilation
overhead without changing the database-wide query limit.

Install `202611020007_calendar_report_performance.sql` using
`release-calendar-performance.mjs --prepare-indexes`, then `--preflight` and
`--apply`. The preparation step builds the two indexes concurrently. Validation
replaces only reporting functions inside a repeatable-read transaction, checks
identical July/October results and requires timings below 6.5 seconds before
committing. Tags, payment records, ad spend and bot settings are preserved.

If a complete report still times out, the API retries smaller authorized Page
batches with at most two concurrent reads and a bounded time budget. Every batch
must succeed before totals are returned. Failed or malformed results never become
zero-filled or partially successful reports. Page filters load independently of
the report and remain usable during an error. Empty ad-filter values mean All
sources; new accounts with no Pages return a correctly shaped empty report.

`verify-calendar-report-matrix.mjs` checks every valid recorded inquiry month for the
largest authorized account, empty/future months, blank/unknown/creative filters,
the largest Page scopes, all six contact-status filters and Page options. It
reconciles daily counts with each complete month's totals and writes no financial
records or customer messages.
Legacy timestamps outside the supported calendar years are listed separately
and their requests must fail validation rather than create fictional dates.

Messenger timestamps are normalized from Unix seconds, milliseconds or ISO at
both the main webhook and shared partner gateway. The gateway preserves Page
routing and signs each normalized payload for its existing destination. This
also protects Pages handled by the existing application from seconds being
stored as January 1970. Event fingerprints use the normalized time so retries
with different units do not create duplicate referrals.

`repair-webhook-seconds-dates.mjs --preflight` checks affected contact, source and
referral dates against independently recorded creation or receipt times. After
deploying the parser, `--apply` updates only records that satisfy this evidence
check, in one transaction. Every old and corrected timestamp is retained in the
private `app_private.webhook_date_repairs` journal. The repair aborts if any
candidate lacks corroborating evidence or if tags, verified-payment records,
ad-spend records or chatbot settings change. Unknown inquiry dates stay unknown.

Profit after salary and ad spend remains selectable. Heat colors follow
the selected value's sign: negative red, positive green, verified zero white,
unavailable gray. Intensity follows absolute magnitude. Signed profit/ROAS labels
and a visible legend keep the meaning readable without relying only on color.
Positive cost amounts remain expenses; color does not rank cost efficiency.

Apply `202611020005_ad_calendar.sql` before deploying. New reporting functions
also require `202611020006_calendar_outcome_sources.sql`. This migration reads
existing confirmations and preserves tags, bot settings and financial records.
Use `release-calendar-outcomes.mjs --preflight` and `--apply` to validate and
install it. `backfill-profile-payment-sources.mjs` can checkpoint complete saved
profile histories for every Page without generating receipt amounts; `--preflight`
rolls back and `--apply` uses short transactions per contact so the active
scanner can continue. Full profile reviews maintain these sources thereafter.

New reporting functions
are server-only; every HTTP read checks Page membership and writes also require
same-origin requests. Migration preflight and application preserve tags, bot
settings and all existing financial/spend records. No fictional receipts are
inserted for testing. SQL fixtures run in PGlite, including later-month receipts,
refunds, voids, Page isolation and cohorts larger than 1,000 leads.

Run Vitest, TypeScript and the production build. `verify-ad-calendar-browser.mjs`
uses synthetic API fixtures in an isolated browser to check arithmetic, heat
colors, later-month cohort drilldowns, creative filters, bounded import and mobile
layout. The live verifier checks authorized real cohort counts and unknown
financial data without making financial records or changing ad budgets.
