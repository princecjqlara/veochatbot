# Hourly Meta Ads fetch

The existing cron-job.org job calling `/api/cron/follow-up-automations` also triggers Meta Ads fetching. Keep that job and its current URL. No additional job, cron-job.org API key or Vercel Ads schedule is required.

The existing route must receive:

- URL: `https://veochatbot.vercel.app/api/cron/follow-up-automations`
- Method: GET
- Schedule: keep its current recurring cadence
- Request header: `Authorization: Bearer <production CRON_SECRET>`
- Save responses: disabled
- Enabled: yes

An atomic database claim limits automatic advertising fetches to one start per 60 minutes for each saved advertising credential. Concurrent invocations and the separate authenticated `/api/cron/meta-ads-sync` worker share that check. A recent completed manual refresh also delays the next automatic fetch for an hour. Existing follow-up, campaign and chatbot work is retained.

The ads task runs in the background within the request's configured duration, so it does not add a blocking ads fetch to the existing cron response. Its actual result is logged with `[META_ADS_EXISTING_CRON]`. The saved credential records `scheduled_refresh_started_at`, `scheduled_refresh_finished_at`, `scheduled_refresh_status` and `next_scheduled_refresh_at`.

Meta consent and a valid encrypted ad-account credential are required before fetching. Without a credential the ads task reports `connect_meta_ads_required`. Interrupted imports resume on the next due hourly run. The manual fetch action remains available in Budget. Advertising budgets and customer messages are never changed by the ads task.
