# VEO workspace: workflow, reliability, performance, and layout plan

Prepared 8 November 2026. This is the implementation plan requested before changing the application. The audit used source inspection and read-only production requests. Changes below are proposed, not deployed by this planning task.

## Outcome and scope

Staff should work from one persistent workspace. They should see what needs attention, open a client, finish the required action, and return to the same list and filters. Facebook collection, receipt verification, Telegram delivery, quotas, warnings, financial records, and chatbot controls must form one consistent workflow.

The scope covers both the Next.js VEO application and the existing Jaucian Telegram bot. Team leaders continue to work directly with editors; a manager is optional. Existing accounts, Page grants, client history, verified payments, seller attribution, commissions, refunds, and launch cutoffs must survive the reorganization.

## Findings established by the audit

The timing samples below are individual authenticated production reads taken on 8 November. They establish a starting point, not a latency percentile or a claim that every request behaves identically.

| Read | Observed time | Implication |
| --- | ---: | --- |
| Workspace context | 1.74 seconds | A much smaller entry read already exists. |
| Main dashboard | 8.89 seconds | The initial workspace currently waits for substantial report work. |
| Receipt list | 1.80 seconds | The receipt view does not need to wait for the whole dashboard. |
| Current warnings | 1.70 seconds | Warnings can load independently. |

Confirmed source behavior:

- The main workspace endpoint runs dashboard, order-list, and team-capacity reports together. Several individual views first request that broad response, then their own component endpoints. The workspace and outer dashboard layout separately fetch the Page list.
- Child views use a broad parent refresh object to trigger additional reads. A small mutation can reload unrelated reports. The read helper allows retries within a 45-second budget, which can make a slow operation appear stuck.
- Facebook checks scan conversation history, up to five message pages. Checks can run at preflight, submission, workspace delivery, the bot's authoritative read, and final Telegram sending. These repeated external reads create latency and repeated opportunities for temporary failure.
- The current Facebook connector recognizes particular Page-authored stage and invoice messages. It does not establish that all Business Suite stage changes or orders are directly available through a dedicated account API.
- All three stored Facebook check records in the audited tenant were complete but had no explicit stage. The business-order observation table contained no orders. This is a concrete reason the current receipt rule can block, even while retained contacts have Messenger-derived Qualified or Converted stages.
- The audit found no current receipt delivery submissions. Both stored receipt records were deleted. This snapshot cannot establish that a real confirmed receipt photo reached Telegram.
- Existing code imports an observed Facebook order only through an explicit import action. A stage change by itself does not currently create that order.
- Automatic fresh-client assignment currently has no three-detail requirement.
- The bot already contains receipt-photo delivery, three daily quota/warning reports, assignment commands, and delivery acknowledgment checkpoints. The live scheduler was healthy and its failed-action list was empty during the audit. Configuration being enabled is separate from proving delivery for a particular receipt or warning.
- Jev is TypeSafe's decision model. The prepared, disabled review adapter currently targets chat completions and expects generated JSON. It must be replaced with the actual Decisions API adapter before Jev is enabled.

Evidence was recorded in the ignored local artifact `.vercel/workspace-cleanup-audit.json`. No clients, payments, availability declarations, or Telegram messages were changed during this audit.

## Product rules to implement

### Fresh inquiries and editor assignment

Use this working interpretation unless the three required fields are specified differently: **any three distinct, valid client answers from the existing form**. The current form includes business name, social link, business location, video goal, video length, style, contact number, and orientation. Collecting the remaining answers continues after assignment eligibility; three answers do not mean the entire form is complete.

1. A fresh inquiry appears in the workspace immediately. Its Telegram notice shows intake progress, such as `Collecting details: 2/3`, without falsely saying an editor has been assigned.
2. Normalize field aliases and use the existing source-backed detail records. Repeated answers to the same field count once. Empty values, placeholders, bot suggestions, inferred guesses, and merely copying a Facebook profile name do not satisfy the rule. A stated absence of a social page is shown as an answer but does not count toward the three substantive details.
3. One shared eligibility calculation governs UI buttons, Telegram callbacks, manual fresh-client offers, automatic offers, and final acceptance. It must run on the server; a disabled button alone is insufficient.
4. Preserve the existing one-hour clock from inquiry arrival. The offer can start only when both the hour has elapsed and three valid details have been saved. If the third answer arrives after the hour, the next scheduled run may offer immediately. Persist the time the detail threshold was met.
5. Only a Ready editor with current branch, Page, and Telegram-group access can receive an offer. Busy editors are excluded. A team can report directly to a team leader.
6. The chosen editor has 15 minutes from acknowledged Telegram delivery to accept. Late buttons fail. A delivered missed offer records a warning and rotates to another eligible Ready editor. An undelivered notification must not produce a missed-offer warning.
7. If nobody is eligible, retain the queue item with a clear reason. Process pending work fairly so an unavailable team or a large backlog cannot starve other teams.
8. Acceptance atomically transfers responsibility and changes the editor to Busy. Fresh assignment creates no sale, payment, Closed Deal, Done Deal, or commission.
9. Recheck the details and permissions before acceptance. If a correction makes a pending fresh inquiry ineligible, cancel its pending offer and show why. Do not automatically remove an already accepted client because a detail was corrected.

### Handovers

`/handover` and the client drawer offer the same transfer workflow. Select a Ready recipient on a shared permitted Page, add a reason, and send a timed handover offer. The current editor remains responsible until acceptance. Declines, cancellations, expired offers, and permission changes leave ownership consistent.

The three-detail gate applies to fresh-client allocation. An existing client's handover retains its existing service and sales history; it does not restart fresh intake or replay an old inquiry announcement. Existing sales retain their recorded seller, payment history, and commission attribution.

### Facebook stages and orders

Create one source history for each contact: stage events, order/invoice observations, source identifiers, event time, last successful collection, and collection errors. Keep stage evidence and order evidence separate.

Use signed webhook events for prompt updates where the connected account exposes them. Reconcile recently changed contacts in a background queue. Resume from a per-conversation cursor; perform deeper scans only for gaps or explicit investigation. Deduplicate and order events using source identifiers and event timestamps so a delayed event cannot overwrite a newer stage.

First validate actual Page permissions and compare known recent Business Suite changes with the payloads returned for this account. Meta's Conversations API documents conversation and message access; that does not prove complete Business Suite stage or invoice coverage. Report the coverage honestly. [Meta's Conversations API reference](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a)

Proposed automation:

| Observed change | Result in VEO |
| --- | --- |
| Explicit supported lead-stage event | Update the contact and stage history, retain provenance, and refresh affected eligibility. |
| Qualified or Converted stage, no usable invoice yet | Open one local draft order/task with known client and service details. Show the missing invoice, total, or seller. A draft contributes no sales or commission. |
| Verified Business Suite invoice ID and price | Import or update the matching order once. Link an earlier Closed Deal only when the match is unambiguous; otherwise show a review task. |
| Price changed on an already linked order | Show a conflict requiring an audited correction. Preserve recorded payments and seller attribution. |
| Payment verified against the actual payment record | Update settlement and the appropriate milestone under the existing financial rules. |
| Stage changed without payment evidence | Update the stage; leave payment unverified. |

For a source Meta does not expose reliably, show `Facebook source unavailable` and an explicit supervisor evidence-review path with source, reason, and audit history. An approved manual observation is labeled as such and must never be displayed as a successful Facebook fetch. This path must be designed into the receipt eligibility rules, rather than requiring staff to press Fetch repeatedly against unavailable data.

### Receipts, confirmation, and Telegram delivery

Use one receipt process inside the client drawer: choose Closed or Done, confirm the relevant order/deal and seller, review payment facts, upload the photo, and see the resulting status.

Separate these states: **Draft → Checking → Needs information / Needs review → Confirmed → Queued → Sent**. Temporary delivery failures show **Retry scheduled**. Deleted, expired, and cancelled states remain explicit. Saving a photo is not the same as confirming a payment or delivering to Telegram.

Confirmation writes one durable delivery event in the same transaction as the confirmed receipt. The existing scheduled outbox owns Telegram delivery. A confirmed receipt with valid access and destination should progress automatically without requiring the user to open another page or submit it twice.

Each Telegram receipt includes the receipt photo, milestone, client, Page, seller/editor, currency, relevant amount, verified paid amount and balance where applicable, deal/order/invoice references, Philippine timestamps, permitted notes, verification status, and a link to the authorized VEO record. A Closed Deal whose payment is not yet verified must say that clearly. Do not expose personal salary or confidential budget values in the group.

Keep the caption within Telegram's limit. Send extra details as separately acknowledged parts if necessary, rather than silently truncating important fields. Each part has a stable deduplication key. Persist Telegram message IDs before marking delivery complete, and show the group/topic and message link in VEO.

Replace the repeated full-history scans with a versioned evidence snapshot. The receipt records which source, stage, order, payment, and permissions versions were checked. The final sender checks current permissions, deletions, financial status, destination, and relevant newer events against the authoritative records. Refresh only stale or unresolved source evidence. A newer conflicting event invalidates the old confirmation until resolved; a temporary fetch failure does not erase previously recorded evidence or financial history.

Closed receipts retain their existing stage-qualified rules and do not require an order merely to be Closed. Done receipts require the correct saved order and verified settlement, including the existing PHP tolerance. Image appearance, a lead-stage label, or Jev's opinion cannot verify a payment.

### Warnings and quota reminders

Preserve the existing reports at **08:00, 16:00, and 00:10 PHT**. The 00:10 report covers the previous work date. Include personal and team Closed/Done totals, remaining quotas, and tomorrow's verified availability.

Add prompt, deduplicated attention events for delivered offers missed, confirmed receipts unable to deliver, receipt holds, access or routing failures, and overdue projects requiring a reason. The daily reports continue even if an individual source or AI worker is unavailable. Report current counts from the same ledger used by VEO; never count a Telegram receipt as another sale.

For each warning store the rule, evidence, affected person/client, first occurrence, resolution, last notification, and repeat policy. Stop resolved reminders. Keep unknown or stale attendance evidence distinct from a missed poll response. Finished work waiting only for a client's balance is not staff overdue.

### Jev AI

Use **`typesafe/jev-1.14`** through **`POST https://openrouter.ai/api/alpha/decisions`**, with application state and typed questions. Jev returns choices and probabilities; it does not generate reply prose. [OpenRouter Jev documentation](https://openrouter.ai/docs/guides/community/jev)

Replace both the current review adapter and its configuration probe. Remove the requirement that Jev generate a free-text explanation or quote; instead attach local evidence IDs and a fixed explanation associated with its returned decision. Keep the existing review leases, state snapshots, and atomic application checks.

Ask whether an ordinary human interruption should remain waiting, stay stopped, schedule follow-up, or resume future automated replies. Use a bounded relevant history containing the latest customer/editor messages, saved details, current ownership, and explicit holds. Store the returned decision, probabilities, model identifier, evidence/state version, and time. Choose waiting when confidence is below a threshold validated on representative conversations, when history is missing, or when the provider fails.

Manual bot-off, opt-out, active editor ownership, completed outcomes, and explicit holds remain authoritative. Recheck state when committing the decision and again before a follow-up sends. A newer customer message, editor message, permission change, or bot setting invalidates an outdated decision. The existing chat model writes any permitted reply through the ordinary send worker. Jev does not change quotas, verify payments, or invent missing client details.

Validate Jev first with synthetic cases and labeled conversation cases, then run it in observation mode before allowing automatic resumes. It is currently disabled; discovery of the correct model does not mean the existing adapter is ready to enable.

## Proposed workspace organization

Use one persistent shell, five primary areas, shared Page/date/team filters, and one client drawer. Browser links remain shareable, but switching an area should retain filters, scroll, selection, and cached results. Load the active panel and drawer sections as needed.

| Main area | Contents |
| --- | --- |
| Work | Today, fresh intake with 0/3–3/3 progress, my clients, incoming offers, handovers, deadlines, and needs-attention queue. |
| Sales | Orders and drafts, Closed/Done Deals, receipts, payment verification, balances, refunds, fulfillment, and attribution review. |
| Team | People and hierarchy, direct team leaders, optional managers, Ready/Busy, Page/group access, attendance, quotas, capacity, and warnings. |
| Reports & Planning | Performance, rankings, personal salary/commission, finance, work calendar, Page budget, ad calendar, ad quality, and demographics. |
| Settings & Tools | Page connections, Telegram routing, chatbot configuration, Jev controls, source health, audit/history, profile, and advanced tools. |

The client drawer has a compact summary and progressive sections for conversation/details, stage/source history, assignment/handover, orders/payments, receipts/delivery, and bot/follow-up controls. Selecting a warning or receipt opens the same drawer at the relevant section. Use plain status labels, one primary next action, inline blockers, and a visible last-successful-sync time.

Default by role: editors see their work and their own results; team leaders see branch workload and unresolved issues; the owner sees organization totals and cross-team administration. Permission checks apply to every read, write, drawer section, and cached response.

Consolidate the duplicated outer-sidebar and workspace-tab links, repeated explanatory blocks, repeated contact searches, and overlapping order/receipt forms. Keep bulk contact tools, tags, pipeline, campaigns, templates, exports, follow-up automations, chatbot knowledge/media, and histories in a searchable advanced-tools group under their current permissions. Existing deep links redirect to the matching panel. Remove confirmed duplicate or unused presentation code after its callers and feature coverage are checked; retain historical data and migrations.

## Fetch, store, then update the screen

The desired data path is **Facebook/Telegram events → durable source queue → normalized records → small workspace summaries → changed rows in the UI**.

- Load a small session/scope/bootstrap response first. Do not gate Receipts, Team, Warnings, or Settings behind finance and capacity reports.
- Maintain compact daily/team summaries incrementally, and repair/reconcile them in the background. Corrections, refunds, offboarding, and permission changes invalidate affected summaries. Use the financial ledger for authoritative writes.
- Share the Page list, client summary, and permissions context across the shell. Split list, detail, counts, and heavy analytics reads. Fetch only visible rows and the selected record; bound search and pagination queries and inspect their query plans.
- Keep a client cache scoped to tenant, user, permissions version, Page, date, and filters. Retain the previous data while refreshing, with an accurate freshness label. Clear or invalidate it on access changes and sign-out.
- After a mutation, return the updated record and affected summary versions. Update those parts immediately after server confirmation; avoid a whole-dashboard reload.
- Use a small version/delta poll while the workspace is visible, initially about every 30 seconds. Pause it in hidden tabs; deduplicate overlapping requests and cancel obsolete reads. Background source workers continue independently of an open browser.
- An explicit Refresh requests one bounded source job and shows progress. Repeated clicks reuse the same job. Source failures show the affected panel's error and next retry while the rest of the workspace stays usable.
- Dynamically load heavy charts, calendars, media previews, and advanced tools. Moving every existing component onto one eagerly loaded page would recreate the same problem.
- Record request duration, slow database calls, source lag, rate-limit responses, queue age, and delivery latency. Keep receipts and timed offers ahead of heavy report work, without allowing guard failures to block due deliveries.

Targets to measure after implementation: usable warm workspace within about 2 seconds, cached panel switches under 300 ms, ordinary small read APIs at or below 1.5 seconds at the 95th percentile, and delta responses below 10 KB for ordinary updates. These are targets, not results achieved by this plan. Measure cold starts and slow mobile connections separately. Receipt sends and offer rotations should run on the first successful scheduled cycle after becoming due, subject to provider availability.

## Implementation order and release checkpoints

## Implementation tracking

This working status reflects the current release candidate; it is not a production completion claim.

- **Intake correctness: implemented and locally verified.** One shared SQL gate counts three distinct valid fields for fresh inquiries across page actions, Telegram actions, and automatic offers. The queue shows progress, checks it again before dispatch, and rotates its scan fairly. Existing claimed-client handovers bypass the fresh-inquiry gate and retain ownership until acceptance.
- **Facebook and receipts: implemented, with live-source limits preserved.** Contact/stage changes enqueue a private source job; a bounded worker resumes Facebook message pagination, stores exact Page-authored stage/order notices, and reconciles drafts. Supervisors can record a scoped stage review with a reason and reference. Receipt checks and sends use saved evidence, while refreshes run separately. Missing or conflicting Meta evidence remains a visible block.
- **Telegram delivery: implemented and locally verified.** Receipt photo acknowledgment is checkpointed before the complete detail message; the second send has its own uncertainty checkpoint. Confirmed delivery details include the Page, stage, invoice reference, verified amounts/times, source, and notes. Delivered-but-expired offers now appear in warnings. Existing PHT quota/warning reports remain enabled, and scheduled deliveries run before new report snapshots are queued.
- **Workspace organization: implemented in the release candidate.** Five grouped areas retain the existing deep links and advanced tools. The client drawer opens from contacts and assignment lists and shows saved details, source history, and order-draft state, with direct assignment and receipt actions.
- **Faster reads: partial.** Most focused panels now load a small permission context and only request accounts or capacity when needed. The combined dashboard and account management retain broader data. No tenant/user-scoped response cache, incremental summary/delta protocol, production latency baseline, or p95 measurement has been implemented yet.
- **Jev: active through OpenRouter Decisions API.** The production probe for `typesafe/jev-1.14` passed. Jev returns a typed choice and probabilities; VEO attaches its own reason and evidence IDs. A 5-minute quiet period is enforced; low confidence keeps the conversation paused. Each decision is rejected if the editor, customer, Page settings, ownership, or conversation snapshot changed. The model is active; review recorded outcomes and adjust the policy if needed.
- **Production release: deployed.** App commits `a9a3e94` and `1cf4175`, plus bot commit `a2c73c6`, are on `main`; Vercel production builds completed, the bot `/api/health` returned `{"ok":true}`, and the app home returned HTTP 200. The app’s `/api/health` route is not present; unauthenticated workspace and cron requests correctly return 401. Database preflight/apply preserved 59 users, 71 Page connections, 658 payments, and the existing launch cutoff.

Before calling the work complete, apply and verify the forward migrations, deploy the app and bot, enable Jev observation only after the model probe succeeds, and complete the remaining source, delivery, permission, mobile, and latency acceptance checks below. The current test/build results are local checks, not live-production evidence.

| Phase | Deliverable | Exit check |
| --- | --- | --- |
| 0 — Baseline | Current behavior inventory, timing/source snapshots, and this plan. | Every existing feature mapped to a destination; uncertain source coverage labeled. |
| 1 — Intake correctness | Shared three-detail eligibility, progress indicators, consistent offer/accept rules, and fair queue handling. | No UI or Telegram path allocates a fresh client early; existing handovers remain valid. |
| 2 — Facebook and receipts | Account capability audit, incremental reconciliation, stage history, draft/order import, evidence-review path, explicit receipt states. | Stage/order changes converge without duplicate orders or fabricated settlement; known blocks have actionable reasons. |
| 3 — Telegram delivery | Confirmed-receipt outbox events, complete photos/details, delivery visibility, warning events, preserved quota reports. | Retry/acknowledgment tests pass; schedules and recovery remain healthy. |
| 4 — Faster reads | Small bootstrap, independent panel endpoints, summary projections, scoped cache, changed-record responses, visibility-aware deltas. | Repeat the baseline measurements and compare query count, payload, and latency under representative load. |
| 5 — Workspace layout | Five-area shell, shared client drawer, compact role views, deep-link compatibility, advanced-tools inventory. | Desktop/mobile task walkthroughs complete without losing feature access, filters, or client context. |
| 6 — Jev and rollout | Correct Decisions adapter, synthetic/labeled evaluation, observation mode, controlled activation. | Decision thresholds validated, explicit holds respected, stale results rejected, provider failure leaves the bot safely paused. |

Release related database, app, and bot changes in compatible steps. Add schema before dependent code, deploy the bot/app pair in the required order, and enable changed automation only after its checks pass. Keep switches for automatic allocation, source reconciliation, receipt dispatch, and Jev separate. Preserve the previous compatible deployment for rollback; do not reverse ledger migrations or erase accepted work to roll back a layout.

For the Telegram project run `py validate_project.py` before deployment. After scheduler changes run `remote_windows.ps1 configure-scheduler --verify-recovery`, inspect `scheduler-status`, and verify read-only `/api/health`. Use normal scheduled runs to verify real delivery; do not manually invoke the dispatcher or send test Telegram posts.

## Required acceptance coverage

| Area | Cases that must pass |
| --- | --- |
| Three details | 0/1/2 answers rejected; 3 distinct valid answers eligible; aliases/duplicates/placeholders excluded; corrections and simultaneous acceptance checked on the server. |
| Timing | Third answer before/after the hour, Ready/Busy, midnight, no available editor, delayed delivery, 15-minute expiry, late clicks, retry without timer extension, and backlog fairness. |
| Handover | Same-team permitted editor, direct team leader, no manager, recipient decline, expiry, original owner preserved until acceptance, revoked Page access, and financial seller preserved. |
| Facebook | Accessible and inaccessible stage data, missing/expired token, partial pagination, non-English/changed notices observed in real payloads, duplicate and out-of-order events, missing invoice, price changes, and ambiguous earlier deals. |
| Receipts | Closed without an order, Done with verified settlement, hold/review resolution, duplicate upload/request, deleted/expired photo, long details split into parts, failed send, acknowledgment retry, and changed destination/access. |
| Quotas/warnings | Three PHT report slots, previous-day closeout, personal/team totals, missed delivered offer versus undelivered notice, warning resolution/deduplication, and stale poll data. |
| Financial integrity | No sale from assignment, no payment from a stage or image, no duplicate milestones from Telegram, preserved refunds/history, exact seller attribution, and existing settlement tolerance. |
| Jev | Actual Decisions request/response shape, wait/stop/follow-up/resume, low confidence, timeout, injection-like conversation text, new human/customer activity, explicit bot-off, active editor, and exactly one permitted follow-up. |
| UI/access | All four staff roles, desktop/mobile, slow/offline requests, one panel failing, direct URLs, restored filters/selection, keyboard navigation, and permission changes clearing cached data. |
| Performance | Representative contact volumes, bounded queries, independent panels, no duplicate Page/context reads, no full-history fetch on navigation, and before/after latency and payload measurements. |

Completion means the source, finance, assignment, delivery, reminder, and navigation cases all pass. A cleaner screen alone does not complete this work.

## Primary implementation locations

- Workspace shell and navigation: `src/app/dashboard/layout.tsx`, `src/app/dashboard/workspace/page.tsx`.
- Intake: `src/components/VeoNewClients.tsx`, `src/app/api/workspace/new-clients/route.ts`, automatic dispatch migration `202611080008`, and new forward migrations.
- Facebook source: `src/lib/veo-business-orders.ts`, `src/lib/veo-facebook-check.ts`, `src/lib/messenger-stage-sync.ts`, webhook/event workers, and Business Suite receipt migrations.
- Sales and receipts: `VeoOperationsPanel`, `VeoReceiptInbox`, `VeoReceiptSaleDetails`, `VeoBusinessOrderPicker`, and the workspace/receipt APIs.
- Background updates and reads: `src/app/api/cron/workspace/route.ts`, `src/lib/veo-events.ts`, `src/lib/veo-report-read.ts`, and scoped summary/read APIs.
- Jev: `src/lib/veo-jev-review.ts`, `scripts/configure-veo-jev.mjs`, and forward migrations for policy/evaluation metadata.
- Telegram repository: `veo_workspace.py`, `veo_intake.py`, `veo_directory.py`, `veo_shift_reports.py`, scheduler/health checks, and their regression suites.
