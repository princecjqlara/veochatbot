# Faster feature data loading

This release reduces unnecessary work across the feature data paths. It does
not retain financial or permission results across HTTP requests.

24 route modules now pass their current Request to Page-access helpers.
Authentication and Page checks share one authoritative workspace scope promise
within that request. Different actors and subsequent requests use separate
reads. Long-running background authorization callbacks retain fresh checks.
This covers chatbot settings/analytics/knowledge/media/Drive/trials/pricing,
pipeline, contact controls, ads reports and conversation exports.

Chatbot Overview requests Pages, configuration, analytics and interruptions.
Knowledge, media and Drive data load together when Knowledge & media is opened;
trial status loads in Test. A completed library stays available within that
mounted Page, and mutations refresh the affected source. Failed initial library
reads show an explicit Retry action. Aborted or obsolete Page/library responses
cannot replace the current selection. Switching accounts remounts the dashboard
content. Knowledge, Drive and media API reads paginate all records and use
stable ordering. Media previews use eight workers while preserving every row.

On the restored source Page, the baseline knowledge metadata was 179,182 bytes
and Drive metadata 440,893 bytes (uncompressed JSON). Those reads and their
four associated background requests (including media and trial) are deferred
from Overview; data remains available in its corresponding section. This is a
request/payload reduction, not a browser rendering or traffic benchmark.

Workspace, New Clients and performance/rankings/salary panels begin initial
loads, refreshes and deliberate filter actions immediately. Only changed search
text waits 250 ms. Contacts coalesces typing, aborts superseded reads, retains
its realtime subscription across filter changes and skips hidden-tab polling.
Returning to a visible tab refreshes the current filters. Silent updates cannot
interrupt an in-flight foreground read.

Contact and campaign tag selectors read complete paginated options instead of
silently stopping at the first 50/100 rows. Contact options refresh per Page,
not on every search or pagination click. A source error remains visible.
Contact-list controls run concurrently with tag attribution; requested tag or
control failures return unavailable instead of a successful incomplete record.
Tag relations paginate fully. Bot controls cover all requested contacts in
100-ID slices with two workers, replacing the former first-100-only projection.
Client cancellation reaches the contact/library database clients.

The release needs no schema migration and keeps the single Singapore database.
Component tests cover section loading, rapid typing, visibility and old-response
handling; integration tests cover lists beyond 1000 rows and current access.
No browser connection was available for visual QA. Live checks read existing
data and do not send customer or Telegram messages. Receipts, financial rules,
tagging, authentication and the existing undeployed receipt-policy draft retain
their established behavior.

Private before/after and release receipts live in `.vercel/veo-data-release/`.
