# Hourly Meta Ads fetch

`/api/cron/follow-up-automations` is the existing integration route for cron-job.org and also triggers Meta Ads fetching. The existing external job must be enabled and authenticate successfully against this route. No additional job or Vercel Ads schedule is required. The application cannot infer that the external job is healthy merely because its route is deployed.

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

Calendar, Ads lead quality, conversion summaries, creative charts, Budget and connection status refresh in the browser hourly. Visibility, focus and network recovery only refresh an overdue report; there is no 15-second report polling or 5-second source-status polling. Changing filters and pressing an explicit refresh still load immediately. Calendar exposes the same connection status and consent action as Ads and Budget. Messenger references are counted separately from complete Marketing API creative inventory.

When the overall Ads report shows All Pages, its creative chart automatically chooses an assigned Page with recorded ads and exposes a separate Page selector. The overall lead report keeps its All Pages scope. A missing advertising credential or an unqueried account never becomes a complete zero-spend report.
