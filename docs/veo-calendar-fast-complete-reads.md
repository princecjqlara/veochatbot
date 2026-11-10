# Faster complete Calendar reads

The app functions now use Singapore (`sin1`), matching the new database's
`ap-southeast-1` region. The previous Sydney configuration added network travel
to each sequential database request. One function region remains configured;
no database move, dual-database setup or plan change is introduced.

All-Pages Calendar requests first use the existing authorized all-Page SQL
functions. A normal monthly read and selected-day read each require one RPC,
instead of one per assigned Page. For the restored 14-Page workspace this
reduces those reads from 28 RPCs to two, excluding scope, planning and finance.
Explicit Page filters retain their own parameters and never broaden into an
all-Pages query.

The fast monthly response must contain every source array and exactly the live
requested Page inventory. A missing source or Page cannot become a zero or a
successful partial financial report. Day details also validate their selected
date and reject clients outside the current Page scope.

A genuine SQL size limit or query timeout can fall back to bounded Page/date
slices. A combined read that exceeds its short budget checks live database
health and Page scope before falling back, so large reports retain the existing
slice path. A SQL timeout waits for the availability gate's short cooldown first.
Authorization failures, provider outages and malformed successful responses
fail without multiplying requests. Sibling Page requests are cancelled when
another read fails. Existing deadlines and two-worker fallback concurrency
remain. Current Page and branch access is checked before every cached read.

The 30-second month cache, 15-second detail cache, explicit refresh, currency
separation, gross/refund definitions and daily average denominator remain.
No rows are sampled or truncated to obtain faster totals. Missing ad-cost
coverage and external credentials remain visible dependencies; speed does not
establish that those inputs are complete.

This release uses existing schema version 137 and requires no new migration.
Tests cover complete batches, explicit Page filters, fallback, timeouts, missing
sources, permission failures, cancelled siblings and financial calculations.
Before/after measurements use the same production verification flow and are
stored in ignored release receipts under `.vercel/veo-speed-release/`.

References: [Vercel region configuration](https://vercel.com/docs/functions/configuring-functions/region),
[region list](https://vercel.com/docs/regions).
