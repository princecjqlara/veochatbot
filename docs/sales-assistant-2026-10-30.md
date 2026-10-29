# Commercial-video sales assistant implementation

Implemented in the existing Next.js chatbot application under `tokko-chatbot`. The root Express starter and the separate `tokkodev` checkout were not rebuilt or changed.

## Result and activation status

The existing chat generator, Messenger webhook, customer state, portfolio delivery, pricing catalogs, follow-up jobs and Pipeline dashboard now support the conversion flow. Natural Taglish, `po`, verified first names and the existing no-emoji voice remain in place.

The production database migrations were applied on 2026-10-30 after release authorization. All 12 commercial-video Page configurations were preserved, with the same one Page enabled. Existing handoff/chatbot database function definitions were checked and preserved. Pricing defaults OFF. The production target is `https://veochatbot.vercel.app`.

Both `202610300001_guided_sales_intake.sql` and `202610300002_chatbot_sales_assistant.sql` were applied in one transaction and recorded in the existing application and Supabase migration histories. The release helper is `scripts/release-sales-assistant.mjs`; release and live verification receipts are saved under `../data/sales-assistant-release-2026-10-30/`.

The new migration defaults pricing to OFF through the empty settings object and runtime defaults. Existing commercial-video Pages use the new guidance when the migrated settings column is present. Unmigrated runtime configurations retain their older behavior. It does not enable any Page.

## Changes

- New conversations receive a four-step process introduction and an optional form offer. Simple first greetings have a response path that does not wait for an AI request. Returning threads use saved milestones and answers.
- The six default sales fields are Business Name, Business Industry, Product or Service, Preferred Style, Goal ng video and Additional Instructions. Administrators can configure fields, questions, inclusion and collection requirements. Required fields guide recommendations; partial form submissions and purchase conversations remain allowed.
- Signed customer form links expire after seven days and load the same `chatbot_contact_states.collected_details` used by chat. There is no separate lead table or lead creation endpoint. Customers can request another form link in chat.
- Chat extraction accepts customer-grounded values and corrections. It distinguishes a business niche from its proper name, ignores negated preferences, and records inferred industry categories separately as unconfirmed suggestions. Field provenance records chat/form source and observation time.
- Atomic updates merge independent form/chat edits. Stale conflicting answers are preserved and the form returns HTTP 409 for customer review. Blank answers do not erase saved details. Duplicate events and delayed extractions are guarded. Generation retries if form edits change its customer context before delivery.
- Completed or partial forms resume the existing conversation. An eligible submission adds a `form_submission` response to the existing job queue. The existing worker reads the latest answers, recommends available samples and offers the next action. Form responses do not require the idle-follow-up toggle to be enabled, but continue to require the bot to be enabled and all existing ownership, stop and delivery checks to pass.
- Samples come from actual retrieved media or configured document IDs resolved through the existing Page/shared library. Selection considers industry/product relevance first and style second. It excludes inactive assignments, unavailable sources and previously sent samples unless requested. Selected videos receive a relevance explanation and use existing cards/carousels. No arbitrary sample URL from a model is accepted.
- Package inclusions and freebies come from approved assigned catalogs or explicitly owner-approved knowledge catalogs. Historical reference rates cannot become approved live offers. Package-specific inclusions use the selected duration where available. Free concepts and free scripts retain the existing no-fee policy and are distinct from paid production.
- Pricing OFF acknowledges paid-price inquiries without sending money amounts, price lists, deposits or quotes. It adds no handoff trigger. Pricing ON uses approved catalogs and can answer immediately without a completed form. Existing configuration revision checks invalidate delivery when settings change during generation.
- Strong paid buying intent is marked hot and bypasses the optional form. The bot continues the original production-detail questions through chat. Free script/concept acceptance is not classified as paid buying intent.
- Sales progress stores introduction/form milestones, stage, temperature, last question, pricing inquiry, recommended/sent samples, displayed inclusions, form submission time and unconfirmed suggestions. Pipeline displays sales stage, priority, latest question and saved answers alongside the existing ownership state.
- Existing follow-up timing controls, job claims, duplicate-copy checks, cancellation, retries and delivery checks are reused. A new atomic reservation caps attempts per customer-response anchor, including overlapping workers; retrying the same job does not take another slot. Enhanced automated sales follow-ups use the existing RESPONSE window. Manual drafts retain their existing path. Sales marketing is not sent automatically using a HUMAN_AGENT extension.

## Handoff preservation

`chatbot-handoff.ts`, `chatbot-policy.ts`, the existing delivery guard, salesperson assignment and handoff notifications were not changed. Existing handoff and continuation SQL functions/triggers were not replaced.

The original eight production fields plus an explicit accepted request still determine the existing commercial-intake handoff. The configurable six-field sales form does not replace that gate. After buying intent, the assistant reuses existing production questions one at a time; customers do not have to complete a form.

The new record-update and follow-up-reservation functions do not write ownership, status, stop reason, pause kind, automation epoch or salesperson assignment. Details can be saved during human takeover without restarting automation. Form jobs are suppressed/cancelled by the existing ownership and stop checks. No second handoff notification or workflow was added.

## Database changes applied

| Object | Change |
| --- | --- |
| `chatbot_configs.sales_assistant_settings` | New JSONB settings column, default `{}` |
| `chatbot_contact_states.sales_progress` | New JSONB progress/provenance column, default `{}` |
| `merge_chatbot_sales_details` | Service-role-only atomic shared-record merge with conflict detection and event receipts |
| `reserve_chatbot_sales_follow_up` | Service-role-only per-anchor attempt reservation using the existing contact/state rows |
| `chatbot_follow_up_jobs` | Existing purpose validator additionally accepts `form_submission`; existing uniqueness and claims are reused |

The migration is repeatable. It adds no new lead, conversation, handoff or sample table. PostgreSQL tests execute the actual migration and RPC functions in an isolated PGlite database.

## Administrator settings

Open **Chatbot → sales settings → Conversion sales assistant** for commercial-video Pages. Save using the existing Page save action.

| Setting | Default / management |
| --- | --- |
| Pricing ON/OFF | OFF; approved packages remain in the existing Pricing Packages dashboard |
| Sales guidance | `confident`; alternatives `gentle` and `direct` |
| Maximum idle follow-ups | 10 per customer response, configurable 0–30; existing timing controls remain in place |
| Conversational collection | Enabled |
| Introduction and process steps | Editable; four default steps |
| Form questions and requirements | Six defaults; enabled/required flags and chat questions are editable |
| Form field additions/order | Advanced settings editor, up to 20 fields |
| Sample assignments | Advanced settings editor: existing `document_id`, industry, product category, style, description and active flag |
| Industry mappings | Advanced settings editor; inferred categories remain unconfirmed suggestions |
| Freebies and promotions | Existing approved pricing catalogs and Pricing Packages controls |
| Follow-up timing | Existing quick-delay, first-day and best-time controls; platform restrictions still apply |

`CHATBOT_FORM_SECRET` optionally signs form links separately. Otherwise the existing `NEXTAUTH_SECRET` is used. `NEXTAUTH_URL`/`APP_URL` supplies the public form origin. The existing cron/worker must run for queued form responses.

## Required scenario results

These are automated local integration tests with mocked AI/transport, plus real PostgreSQL function tests. They are not a claim of live Messenger delivery or measured conversion improvement.

| # | Scenario | Result |
| --- | --- | --- |
| 1 | New inquiry | PASS: process and optional form; greeting path does not call the model |
| 2 | Customer ignores form | PASS: conversational extraction, concise education and one question |
| 3 | Partial form | PASS: known answers retained; only missing relevant details requested |
| 4 | Complete sales form | PASS: actual relevant sample selected and next sales action offered |
| 5 | Messenger details | PASS: shared record values extracted; inferred category remains distinguishable |
| 6 | Customer correction | PASS: correction accepted; unsupported guesses and stale writes rejected |
| 7 | Pricing OFF | PASS: acknowledges inquiry; no amounts or new handoff trigger |
| 8 | Pricing ON | PASS: uses approved full catalog without requiring form completion |
| 9 | Existing handoff | PASS: original gate unchanged, human ownership retained and details available |
| 10 | Unresponsive customer | PASS: contextual follow-up; no introductory/form restart; atomic attempt cap |
| 11 | Returning customer | PASS: saved state resumes even with shortened recent history |
| 12 | Immediate buying intent | PASS: optional form bypassed; purchase conversation and original production questions continue |

Additional checks cover signed-token forgery/expiration, cross-origin/unknown-field rejection, partial form saves, HTTP 409 review, simultaneous disjoint updates, duplicate events, negative preferences, free-script acceptance, sample relevance/activation, public RPC denial, migration repetition and overlapping follow-up workers.

The local browser fixture checks the mobile/desktop form, six non-blocking fields, saved values, visible unconfirmed suggestions, conflict review and partial submission. It intercepts every form request and makes no live customer writes. Screenshots and machine-readable receipts are under `../data/sales-assistant-browser-2026-10-30/`.

Verification commands:

Final verification: **1,198 / 1,198 automated tests passed**, including all twelve scenarios, persisted admin settings with database field projection, and eight PostgreSQL migration/concurrency checks. TypeScript and the production build passed. Lint completed with zero errors and 18 existing warnings. Mobile/desktop browser fixtures passed with zero runtime exceptions.

```text
npm test
npx tsc --noEmit --pretty false
npm run lint
npm run build
node scripts/verify-sales-form-browser.mjs
node scripts/audit-sales-assistant.mjs
```

The browser fixture expects a local server on port 3017 and an installed Chrome executable at the script's documented path. The read-only audit uses the existing local database configuration.

## Files and components

New sales components:

- `src/lib/chatbot-sales-assistant.ts`: settings, extraction, sample relevance and sales message rendering.
- `src/lib/chatbot-sales-store.ts`: signed form links, atomic updates, assigned sample resolution and existing-queue form responses.
- `src/app/api/sales-form/route.ts`: signed form read/partial-save endpoints.
- `src/app/sales-form/page.tsx`: customer form and conflict review.
- `src/components/ChatbotSalesSettings.tsx`: administrator controls and advanced editor.
- `supabase/migrations/202610300002_chatbot_sales_assistant.sql`: additive migration.

Existing integration points modified:

- `src/lib/chatbot.ts`: existing generation, extraction, follow-up prompts and output selection.
- `src/lib/chatbot-control.ts`: optional sales-progress type only; control functions unchanged.
- `src/lib/chatbot-form-progress.ts`: sales-form progress alongside existing production progress.
- `src/lib/chatbot-message-renderer.ts`: new structured blocks and reuse of production questions.
- `src/lib/chatbot-pricing.ts`: pricing mode gate and direct approved-price eligibility.
- `src/lib/chatbot-follow-ups.ts`: existing worker integration, attempt cap and form responses.
- `src/app/api/facebook/webhook/route.ts`: shared-record capture, generation context, conflict retry and delivery receipts.
- `src/app/api/pages/[pageId]/chatbot/route.ts`: persistent settings and draft-preview validation.
- `src/app/dashboard/chatbot/page.tsx`: sales-settings component.
- `src/app/api/pages/[pageId]/pipeline/route.ts` and `src/app/dashboard/pipeline/page.tsx`: saved progress access and display.
- `.env.example`, `package.json`, `package-lock.json`: optional signing key and PostgreSQL test dependency.

Tests and verification:

- `src/lib/__tests__/chatbot-sales-assistant.test.ts`
- `src/lib/__tests__/chatbot-sales-migration.test.ts`
- `src/app/api/sales-form/route.test.ts`
- `scripts/verify-sales-form-browser.mjs`
- `scripts/audit-sales-assistant.mjs`
- `scripts/release-sales-assistant.mjs`
- `scripts/verify-sales-assistant-release.mjs`

Concurrent guided-sales edits found during this task were retained as a legacy compatibility path rather than overwritten. They include `chatbot-guided-sales.ts`, its migration/release script, and the existing guided form/type/interaction changes. Migrated sales-assistant settings take precedence over that older optional mode.

## Remaining rollout limits

- Production readiness is checked through public routes, signed form reads and existing administrator previews. This verification does not initiate a real customer Messenger exchange, change conversation ownership or enable additional Pages.
- Queued form responses run on the existing worker cadence, once per inbound anchor. Outside the valid response window, the form saves successfully and the customer can continue in chat; saving a web form does not reset Messenger's messaging window.
- Existing stopped/human-owned conversations stay stopped. Their information remains available to the salesperson.
- Freebies require an approved catalog. Sample recommendations depend on actual available videos, useful metadata and optional administrator assignments. No asset or offer is invented when unavailable.
- Conversion lift requires measurement after rollout; it has not been established by local tests.
