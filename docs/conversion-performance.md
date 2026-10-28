# Page and creative conversion performance

The main Dashboard shows today's per-Page summary. Ad Lead Quality adds the same
summary for its selected first-inquiry dates, plus creative totals and daily
creative cohorts. All date filters use Asia/Manila. Contacts remain Page-scoped;
identities are not guessed across different Pages.

## Two different conversion counts

**Payments in period** counts each contact's first documented payment/deposit
whose confirmation timestamp falls in the selected period, even if they first
inquired earlier. Its mean and median use inquiry-to-first-confirmation durations
for those payers only. This is not revenue, full settlement, or repeat payments.

**Cohort payers now** counts documented payers from the original inquiry cohort,
including payments made after that inquiry day ended. Current rate is confirmed
cohort payers / original cohort inquiries. CRM Converted is not payment evidence.
The payment timestamp must be after inquiry and before the verified source cutoff.
An incomplete source or conflicting first-inquiry timestamp cannot verify a payer
for that cohort. Legacy CRM inquiry dates and source coverage remain counted.

## Expected outcomes

The shipped model is `dd7f0ca783ad1651`; its formula and weights are unchanged.
For horizon H in 7, 14 and 30 days from inquiry:

`expected cohort confirmations(H) = known confirmations by H + sum(remaining contact probabilities by H)`

`projected cohort rate(H) = expected cohort confirmations(H) / original cohort lead count`

Expected buyer counts are fractional and are not rounded into actual conversions.
An observed completed horizon contributes its known outcome. Ongoing estimates
require a complete, timestamp-aligned history checked within 15 minutes, with no
newer tracked activity and the existing timestamp-safe conversation features.
Other leads remain unknown, not negative. A whole-cohort point projection is N/A
if any necessary source is missing. Internally, lower/upper missing-data bounds
retain the covered expected count and add zero/all unknown outcomes respectively;
these are not statistical confidence intervals.

The report calculates an expected outcome without a chosen conversion-rate goal:

`expected additional payers = sum(remaining unpaid contact probabilities through each first-inquiry Day 30)`

`expected cohort payers = all documented cohort payers so far + expected additional payers`

`expected cohort rate = expected cohort payers / original cohort inquiries`

All recorded payers remain included, including those who paid after Day 30.
The separate Day-7/14/30 columns retain their original-window definitions. No
additional payment is projected beyond the model's 30-day horizon. Cutoff dates
show when those modeled windows end; they are not predicted purchase dates.
For a multi-day cohort, the dates span the earliest/latest inquiry's cutoff.
This expectation is a probability-weighted average, not a statistical mode or
maximum possible rate. No independent-customer assumption is needed to sum the
expected values. The existing five-Page model is aggregated by Page/ad/day; no
creative-specific retraining or improved accuracy is claimed. Small samples
remain uncertain. All 210 independent Python probability cases still match.

## Evidence freshness

The summary shows how many period conversations need verification. Today's view
checks a bounded batch of up to eight conversations per minute while visible;
the explicit verification button processes at most 320 contacts per run, with
two concurrent reads and no messages sent. Unavailable histories remain flagged.
Historical ranges use that explicit action. The normal complete-history refresh
preserves exact first-message ad identity and the immutable first-issued forecast
ledger. Page message echoes invalidate cached evidence without asserting payment
or changing contact stages, handoffs, bot permissions or messaging jobs.

## Actual daily ad spend

The read-only import requests Meta Insights at ad level with `time_increment=1`,
spend, currency, account, ad ID and daily date boundaries. Only inventory ads
already verified for an authorized Page and the exact account can receive spend.
Permissions and account access must exist in the signed-in Facebook user token;
Page preview access alone is insufficient. Import Facebook ads first, then use
**Refresh actual daily spend**. Requests cover at most 31 dates, paginate by 100
rows, and save actual supplied rows. A bounded UI run makes at most 100 requests.
All-time imports the latest 30 days; select custom dates for older imports.

Account timezone is retained. A daily amount is combined with a PHT inquiry day
only if both of its real timezone day boundaries match PHT. Otherwise spend is
flagged and PHT cost ratios stay N/A. Currency is never converted or mixed.
The API accepts explicit reported zero; an absent day is never invented as zero.
Period totals require every selected reporting date and a single currency.
Partial recorded amounts and covered dates are shown separately. Spend updates
retain their checked time; today's Meta values can be delayed or revised.

`cost / linked inquiry = complete matching ad-day spend / source-linked cohort inquiries`

`cost / confirmed payer = complete matching ad-day spend / confirmed cohort payers`

These costs apply to verified linked contacts; incomplete historical ad-source
coverage prevents interpreting them as a complete Ads Manager acquisition cost.
The earlier workbook has ad labels and daily spend but no ad IDs/account timezone;
its totals are not assigned to creatives by label, date, budget or proportion.

API reporting uses database aggregates and keyset paging, including cohorts
larger than 1,000 contacts. Creative rows are paginated in the UI without changing
totals. All endpoints require Page membership; mutations require same-origin
requests. Only service_role can access spend/report SQL directly.

Apply both `202610290001_conversion_performance.sql` and
`202610290002_fast_conversion_reports.sql`. The second migration selects narrow
inquiry/activity keys before loading cached conversation features and uses custom
query plans for different dates/Page selections. This avoids the slow generic
plan observed in the live reporting check. The release operator applies and
rehearses both migrations; its 14 data and access invariants are rolled back.

Meta's primary references: [Insights fields](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adsinsights.py),
[Insights parameters and account timezone fields](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py).
