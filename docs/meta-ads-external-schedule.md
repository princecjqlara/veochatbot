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

The Owner's existing Page grants are checked automatically before requiring fresh Meta consent. A reusable Page grant must match this app and its assigned Page, remain valid, carry advertising read permission, and expose a complete account directory through its issuing user. The Page itself has no `/me/adaccounts` edge. The verified issuing-user directory supplies inventory and Insights account access. A working Page grant is retained encrypted with `credential_origin=connected_page`; existing advertising credentials are never overwritten. The service-only discovery claim prevents retry bursts and attempts discovery at most hourly.

Owner reports trigger this discovery and the initial import automatically. The existing cron worker also discovers eligible saved Page grants before its normal hourly import. If no saved grant can verify complete access, Connect Meta Ads remains the recovery action. Both authorization paths prepare up to 93 days of initial history; newer monthly windows are processed first, and interrupted imports resume on the next due hourly run. The manual custom-date fetch remains available in Budget. Advertising budgets and customer messages are never changed by the ads task.

Calendar, Ads lead quality, conversion summaries, creative charts, Budget and connection status refresh in the browser hourly. Visibility, focus and network recovery only refresh an overdue report; there is no 15-second report polling or 5-second source-status polling. Changing filters and pressing an explicit refresh still load immediately. Calendar exposes the same connection status and consent action as Ads and Budget. Messenger references are counted separately from complete Marketing API creative inventory.

When the overall Ads report shows All Pages, its creative chart automatically chooses an assigned Page with recorded ads and exposes a separate Page selector. The overall lead report keeps its All Pages scope. A missing advertising credential or an unqueried account never becomes a complete zero-spend report.

Today's delivery counts and delivery costs can appear as provisional snapshots only after source coverage confirms an all-account read with matching row timestamps. Missing, mismatched or partially written snapshots remain unavailable. Provisional delivery never becomes final net profit or ROAS. Messenger referral counts come from the retained referral events, so importing full creative metadata does not make those references disappear.

Creative thumbnails use the inventory thumbnail or verified story image. When the inventory omits a preview, the import uses that Page's saved grant to resolve the verified Page post, retaining the ad's Marketing API identity. Preview reads have a bounded time budget and do not block spend collection when Meta cannot return media. Page grants and advertising tokens stay on the server.
