# Acquisition-day calendar and creative economics

Ad Calendar & Profit groups leads by their first inquiry date in Asia/Manila.
The same day retains its cohort after midnight or month end. Current stage
conversions, later conversions, verified first receipts and lifetime recorded
cohort revenue update that original day. Filters support month, authorized Page
and originating ad. A selected day has timing buckets and paginated contact links.
Unknown sources have a separate view and receive no allocated advertising spend.
The contact Sources view links each referral to the corresponding ad/calendar day.

The heat map can show spend, inquiries, stage conversion rate, verified payers,
payer rate, CPA, cost per Meta conversation, profit, gross ROAS and net ROAS.
Profit uses diverging gain/loss colors. Unavailable data stays gray. Daily cells
also show ad spend, inquiry count and current Converted stages. Future days are
disabled and today is provisional. Larger values have stronger colors; expensive
acquisitions are not labeled better just because they are darker.

## Counts and attribution

Stage conversions count the cohort's current `converted` stage. A documented
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

Apply `202611020005_ad_calendar.sql` before deploying. New reporting functions
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
