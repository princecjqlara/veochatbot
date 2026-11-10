# Dashboard UI and loading improvements

This local update covers all 17 dashboard page implementations, their workspace
areas, sign-in, the customer sales form, and shared error/loading screens. The
separate `veo ad budget` project and archived Express prototype are outside this
pass.

Every dashboard page now uses one content container. Shared cards, fields,
buttons, tables, pagination and dialogs use consistent spacing, softer borders,
readable headings and visible keyboard focus. The sidebar includes a page search,
the header identifies the current area, and contact profiles retain their parent
Contacts highlight. Deals sits with receipts and salary in Sales. Mobile screens
use one padding layer, scrollable wide tables and a collapsible menu. Reduced
motion preferences are respected. Toasts have visible styles, accessible status
announcements and a dismiss button. Dialogs retain keyboard focus, restore the
opening control and scroll state, and give nested dialogs unique labels.

## Loading and completeness

- Client typing refreshes only the scoped client list instead of repeating the
  team finance/capacity read. Search waits 250 ms; initial loads and deliberate
  page or pagination changes start immediately. Obsolete client responses cannot
  replace the current results, even if their transport ignores cancellation.
- Opening a workspace area starts its context read immediately. An unavailable
  initial read shows an error and Retry, rather than an empty completed report.
  Failed refreshes label previously loaded results as such.
- Detailed dashboard panels still load only on first open. Closing them retains
  their data, filters and form state, avoiding a fresh initial request on reopen.
- Offscreen contact photos and chatbot media images use native lazy loading and
  asynchronous decoding. Contact thumbnails have explicit dimensions.

There are no database, migration, API, authorization, financial calculation or
pagination changes in this UI pass. Existing uncommitted receipt/order policy
work is preserved and excluded from the UI release. Implementation validation
performed no production database writes or messages. A comparison against the original navigation confirms every route
remains present: 23 for Owner, 23 for team leaders, 20 for managers, 17 for
members and 25 for legacy sessions. Search filters only those existing links.

## Verification

The production build passes. The final focused run passes 44 tests across 10
files, including role navigation, legacy deal links, client request counts,
stale-response protection, deferred state retention, retries, dialog focus,
sign-in, contacts, pipeline and chatbot loading.

The initial mixed working-directory suite passed 1,991 tests, with the same 12 failures across four files
observed before this UI work. Those failures are in `VeoWorkflow.test.ts`,
`veo-receipts-sql.test.ts`, the workspace cron route tests and the receipts route
tests; they involve the existing receipt/order-status draft and cleanup coverage.
These failures were not suppressed. The stale-response test added after that
run is included in the passing focused run.

Release validation uses a clean Git worktree containing the UI commit and the
existing committed receipt policy. All **2,001 tests in 266 files pass** there,
and the production build passes. The older cleanup test now allows the worker
coordination lease before simulating a salary outage and checks that photo
deletion precedes salary maintenance. This corrects its mock without changing
worker behavior. The budget comparison tests use the original sibling budget
calculator fixture, with the same relative directory layout as the workspace.

Read-only pre-deployment production checks pass for the home page, credential
sign-in provider, Owner context/session, anonymous rejection, scoped contact
search and two distinct 25-row pages. The snapshot records 316 visible contacts,
14 assigned Pages and the existing launch cutoff. Post-deployment checks compare
these values and verify the new sign-in and dashboard navigation assets.

Builds and component tests do not establish production data coverage
or end-to-end external-service behavior. No browser was connected, so interactive
visual verification could not be performed. No wall-clock speedup is claimed;
the performance evidence is reduced duplicate requests and retained panel state.

Ignored validation logs are `.vercel/ui-baseline-tests.log`,
`.vercel/ui-final-tests.log`, `.vercel/ui-focused-tests.log` and
`.vercel/ui-build.log`.
Clean-release build and full-test logs are in
`../../.report-work/ui-release-20261110/.vercel/`; before/after production smoke
receipts are `.vercel/ui-production-before.json` and `.vercel/ui-production-after.json`.
