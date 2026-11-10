# Feature parity audit — 10 November 2026

This follow-up checks the reorganized dashboard against the existing dashboard
routes and the feature-retention requirements in `veo-workspace-reorganization-plan.md`.
It also checks the deployed APIs and current production schema without creating
messages, campaigns, sales, receipts or customer records.

## Confirmed gaps corrected

| Area | Result |
| --- | --- |
| Navigation | Pipeline, campaigns, exports, history and 7-day contacts are reachable in the menu for the roles whose existing APIs allow them. Owner navigation covers every implemented top-level dashboard page. |
| Configuration permissions | Team Leaders and other staff no longer see configuration links their existing permissions reject. Owner tools include Welcome message and Pages & connections. API permissions are unchanged. |
| Contact tags | Manual tag options load every server page, including options after the first 1,000. An incomplete load shows an error and retry instead of an apparently complete subset. System and stage-history tags remain separately maintained. |
| 7-day contacts | Tag filters load completely, failed loads and Owner follow-up draft failures are visible and retryable, Page deep links are honored, and staff do not request the Owner-only follow-up configuration endpoint. Hidden tabs pause periodic refreshes and refresh when visible again. |
| Contact shortcuts | Order and balance-paid links open the current Receipts / Business Suite workflow with the contact preselected. Done Deal links also preselect the receipt kind. |
| Contact details | Switching contacts clears the previous contact's editable details while the new record loads. Late results cannot replace the current contact. |
| Welcome settings | Changing Pages cancels the previous load and ignores late results. Unavailable settings cannot be saved as an empty configuration. Load errors support retry; failed saves retain the typed draft and show the failure. |
| History | Changing Pages or filters cancels the previous request and ignores its late results. Page deep links are honored. |

This release changes no database schema, sales rules, role permissions, launch
cutoffs or historical-import policy. Existing unrelated local receipt-policy
drafts are excluded from the release.

## Verification

- Full regression suite: **2,060 tests in 275 files passed**.
- Production build, including lint and type checks: passed. Separate TypeScript
  check and `git diff --check`: passed.
- Regression cases exercise more than 1,000 tags, incomplete later batches,
  retries, rapid Page switching, late responses, failed welcome saves, contact
  switching, role-based menus and background polling.
- Read-only production schema check: all **139 expected migrations** match,
  required tables and functions for all eight checked feature areas are present,
  protected functions and photo storage remain private, and no invalid indexes
  were found.
- Read-only production API baseline: **14 Pages / 319 unique contacts**. Complete
  paginated contact lists agree with both workspace totals and pipeline totals.
  Contacts, manual tags, tag filters, history, pipeline, welcome settings and
  7-day contact queries return successfully for every Page. Campaign and export
  listing endpoints also return successfully. The workspace launch cutoff is
  unchanged.

The baseline is a point-in-time inventory; live webhook traffic may add contacts
during subsequent verification. No browser is connected in this environment, so
visual browser review is unavailable. Component regression tests, build output,
deployed screen assets and authenticated API reads provide the available checks.
Real customer writes and external permission dialogs are not exercised by these
read-only production checks.

## Operational setup still pending

At the audit baseline, Page connection health reports six ready Pages, seven
needing setup and one requiring reconnection. Those eight Pages require the
Owner's valid Facebook authorization and connection setup in Pages & connections.
They remain in the Owner's complete directory with their retained data.

The database inventory also reports six active account records needing login
setup and zero ad-spend coverage records. Staff login details, ad-account access,
spend coverage and Telegram routing still need operational verification using
the real accounts and external services. Schema availability and successful
read endpoints do not establish that those external setups are complete.
