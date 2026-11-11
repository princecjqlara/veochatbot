# Ad budget and creative reporting audit

The live audit on November 11, 2026 found 15 authorized Pages, but no saved
Marketing API credential, budget snapshots, daily spend or spend-coverage rows.
The 12 saved ad catalog entries were Messenger referral records on six Pages,
not a completed creative inventory import. There were 123 verified originating-ad
relationships and 303 other tracked contacts without a verified origin at audit
time. These counts can grow through normal Page activity.

The Owner can now use **Connect Meta Ads** in Budget or Creative performance.
This keeps the existing VEO identity and Page connections. The separate,
single-use Owner-bound OAuth grant requests `ads_read`, validates accessible
accounts and retains an encrypted expiring credential. Cancelled, partial or
failed authorization preserves previous advertising credentials. Marketing
access requires the Owner's Meta consent; it cannot be inferred from Page
authorization. No production credential or customer sale is fabricated for QA.

Successful consent returns to Budget and starts a read of the previous 14
completed dates plus provisional today. Owners can fetch up to 93 real dates
through today. Inventory and every connected account's unfiltered daily Insights
are paginated with repeated/missing cursor checks. Historical ads are resolved
or stay explicitly incomplete; missing ownership is never guessed. Verified
zero rows are written only after complete reports. Monthly progress is retained
for unchanged retries, with account and Page-scope changes invalidating old
checkpoints. A credential-level lease prevents overlapping manual and hourly
scheduled refreshes. Source status shows missing access, expiry, last complete
fetch, errors, verified inventory count and running refreshes.

Known referral-only creatives are resolved even when neither current inventory
nor recent spend includes them. An unconnected known advertising account keeps
the fetch incomplete before a no-ads budget or zero-spend result can be certified.

Actual detected campaign/ad-set settings appear for all permitted Pages even
before a selling team exists. The latest detected settings have their own
timestamps and stale indicators, independent of a historical VEO planning date.
Shared budgets are allocated by active-ad count with conserved remainder cents,
including non-VEO placements. A zero campaign budget does not hide a funded
ad-set budget; missing, lifetime and inconsistent observations remain unknown.
Saved plans for revoked Pages are excluded. VEO recommendations and Meta's
settings are separate; this workflow never writes an advertising budget to Meta.

Creative reporting now includes verified payments from both Qualified and
Converted leads, matching financial eligibility. Stable payment/order identities
prevent duplicate rows without merging legitimate equal-amount payments. Verified
retained receipts without workspace orders still count as paying clients, while
unknown retained commission prevents fabricated net profit.

For an originating-inquiry cohort, let R be verified receipts through now less
refunds, S the actual completed-order commission, and A acquisition-date ad spend:

- Revenue ROAS = R / A.
- ROAS after commission = (R - S) / A.
- Net contribution = R - S - A.
- Profit ROI = (R - S - A) / A.
- CPA uses unique paying clients; cost per paid order uses distinct paid orders.
- CPL, cost per Converted lead, CPC, CPM, cost per messaging start and cost per
  ThruPlay use their explicitly labelled counts. CTR and video completion use
  summed compatible counts, rather than averages of daily percentages.

Currencies are separate and zero denominators are unavailable. These are VEO
verified-payment cohort figures; they are not Meta pixel-purchase ROAS. Future
commission, unrecorded expenses and tax remain excluded. Final cost ratios require
closed, PHT-aligned dates and canonical Page spend reconciliation, including
freshness, duplicate counts and aggregate amount checks. Current-day, missing and
unreconciled data remain incomplete. The operating-CPA calculation also requires
the full matching completed lookback window since launch. Historical frozen
salary and quota rows are not rewritten.

Daily reach is not summed into a unique range audience. The weighted daily
frequency has coverage requirements; exact selected-ad range frequency is read
separately from Meta and missing/null frequency is never coerced to zero. Origin
coverage reports unknown/conflicting clients excluded from creative totals.
Imported contact identities do not prove historical inquiry dates or ad origins.

Creative inputs are indexed by originating ad in memory, and daily detail is
returned for the selected/default creative. All creative summaries remain in the
selection list and another selection fetches its complete daily detail. Client
request keys and abort checks prevent late Page/ad/date responses from replacing
the current selection. Budget calculations likewise reject stale previews after
inputs, dates, Page/team selection or capacity change.

Field names were checked against [Meta's official Insights SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adsinsights.py)
and [ad-set SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adset.py).
The long-lived token exchange follows [Meta's OAuth client implementation](https://github.com/facebookarchive/php-graph-sdk/blob/5.x/src/Facebook/Authentication/OAuth2Client.php).
The interactive consent and a real account fetch remain dependent on the Owner
connecting Meta Ads. Automated tests use isolated fixtures; production verification
reads status and protected reports without changing Meta settings or sending messages.
