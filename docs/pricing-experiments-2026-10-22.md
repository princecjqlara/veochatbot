# Pricing packages and experiments

The **Pricing Packages** dashboard at `/dashboard/pricing` manages Page-specific, immutable pricing runs. Apply `supabase/migrations/202610220002_chatbot_pricing_experiments.sql` after the existing application migrations and deploy the updated application. The migration is additive and creates no runs, changes no bot switches, and sends no messages. The bot continues its existing behavior when the pricing RPC has not yet been installed; the pricing dashboard reports the required setup.

## Create and operate a run

Select a Page, choose **New pricing run**, and enter the approved package names, total PHP prices, inclusions, deposit/balance terms, and promotional copy. The app adds the exact total price automatically. Copy can include `{first_name}` and `{business}`. Add up to ten packages. Use packages for the same customer need; optionally limit a commercial-video run to one selected duration in seconds.

**Load current + 3 approved catalogs** prepares four complete catalog arms: the current bot catalog as a verified control, plus the three additional catalogs supplied by the owner. It reads the selected Page's current shared knowledge source without rewriting it. An incomplete or unverifiable control blocks loading instead of substituting old prices. Review and start the draft on the intended Page to activate it after deployment.

Each catalog contains 16s, 24s, 32s, 40s, 60s and 120s options with separately counted eight-second videos, posters and captions. The additional hooks and prices are preserved exactly:

| Catalog / hook | 16s | 24s | 32s | 40s | 60s | 120s |
|---|---:|---:|---:|---:|---:|---:|
| PREMIUM ADS, PREMIUM FREEBIES, ONE PACKAGE! | PHP999 | PHP1,199 | PHP1,499 | PHP1,799 | PHP2,299 | PHP3,699 |
| ISANG MAIN VIDEO + DALAWANG BONUS VIDEOS! | PHP799 | PHP999 | PHP1,299 | PHP1,499 | PHP1,899 | PHP2,999 |
| MAS MARAMING ADS, MAS MARAMING WAYS TO PROMOTE! | PHP899 | PHP1,099 | PHP1,399 | PHP1,699 | PHP2,199 | PHP3,499 |

Premium includes one extra 16-second bonus video at 60s and one extra 24-second bonus video at 120s, in addition to its listed eight-second videos. Those extras are not added to other catalogs. The existing commercial PHP150 deposit and balance are rendered from the selected total. The numbered production process remains in place.

Catalog runs wait until the customer's desired duration is known and supported by every catalog. Assignment is balanced independently within each starting-duration cohort, and a changed duration retains the customer's assigned catalog. A reserved source keeps its exact duration and price snapshot on retry. Follow-ups offer the next catalog for the currently discussed main duration. The dashboard's **Starting duration** filter compares matching initial needs; outcomes remain in their starting cohort when the customer later changes length. The all-duration view combines those cohorts. Catalog rows are never treated as 24 separate competing test arms.

Only inquiries first received after the run starts are enrolled. Existing clients retain their established pricing. After a promotional alternative is delivered, later price and inclusion answers use that latest delivered catalog, including exact caption counts and the approved Premium bonus videos. Original assignment and starting duration remain fixed for outcome reporting. The latest catalog remains available to conversational answers when a run is paused or archived; pause stops new offers rather than rewriting an acknowledged quote.

- **Fair test:** at least two packages, balanced initial allocation, no alternative package promotions.
- **Package sequence:** everyone starts with the first listed package, then receives remaining packages in listed order.
- **Fair test + promotional follow-ups:** balanced first packages, followed by the remaining packages in cyclic order from each customer's starting package. Comparisons describe the complete sequence grouped by its starting package.

Assignment occurs when the bot is about to answer a pricing question or render the commercial pricing step. It does not interrupt the business/sample/duration flow. Page-level transaction locks serialize selection; the least-assigned package wins, with randomized ties. One durable assignment per contact and run makes webhook retries and returning customers retain their first package. Allocation balances assignments, while the dashboard separately reports acknowledged deliveries.

The starting catalog stays fixed for a full 24 hours after its first acknowledged delivery. Ordinary reminders use that catalog. A dedicated `pricing_promotion` job offers each alternative once on the configured later days (AI Chatbot settings, normally days 2, 3, 5 and 7), with at least 24 hours between alternative catalogs. Only the next alternative is queued; overdue offers cannot bunch together. The legacy minute-gap setting remains in old run records for compatibility but no longer controls catalog rotation.

Promotional packages use only `RESPONSE` jobs, with a one-minute margin before the response boundary, and never use the day 2–7 `HUMAN_AGENT` path. A later-day offer outside that window is retained as `waiting_response`, displayed in the dashboard's Page-wide waiting count, and reconsidered when a customer returns and the bot schedules the new conversation. This app currently has no dedicated marketing-message integration for unsolicited later-day promotions; held jobs do not send automatically through another channel. Pausing, staff handoff, trial changes and newer inbound messages preserve the existing cancellation and eligibility checks.

Bot/follow-up switches, trial contacts, inbound cancellation, staff ownership, refusals, opt-outs, completed intake, terminal pipeline stages, and the existing live Messenger handoff checks remain in force. Qualified/Not Qualified/Order Created/Converted Page system tags also block further package reservations and deliveries. Pause is checked again immediately before sending an offer.

Starting a new run archives the previous run atomically. Catalogs are not edited in place. Earlier results remain available in the run picker. Customers already shown an offer in any earlier run on that Page are excluded from new runs to avoid changing an existing offer and contaminating the comparison.

## Metrics and tags

The experiment creates a Page-owned tag for each package: `Price: <run name> / <package name>`. A tag is applied only after Messenger returns a message ID. Reserving, generating, or failing to send an offer does not count as exposure or conversion.

Database triggers observe subsequent pipeline transitions and insertion of Page system outcome tags. They record Qualified, Not Qualified, Order Created, and Converted once per customer and stage, within the run's configured attribution window after the first acknowledged exposure. Orders and conversions imply qualification for funnel arithmetic. Converted and Order Created remain separate observed events. Old stages and tags are not backfilled as new conversions.

The main table attributes outcomes to the original assigned package even after alternative offers. Qualification and conversion rates divide by customers actually shown a starting offer; converted-from-qualified divides by qualified customers. Empty denominators display an em dash. The second table counts unique viewers, promotional sends, and outcomes attributed descriptively to the latest delivered package. It is not a causal comparison. Minimum sample progress is a review aid, not a significance test, and the app never automatically picks a winner. Recent cohorts may still convert before their attribution windows end.

The API checks authentication and Page membership on reads, run creation, and pause/resume. Tables use RLS and service-role-only access; SQL functions are not executable by anonymous or ordinary authenticated database roles.

## Delivery recovery

Only one open offer reservation is permitted per assignment. Retrying the same source reuses a reservation that has not begun sending; another source cannot leapfrog it. A durable `sending` checkpoint is saved before calling Messenger. An offer is released when processing ends before that checkpoint. After sending begins, timeouts, crashes, and acknowledgement-recording failures retain the receipt for review, and the follow-up job is not automatically retried. Already-sent or in-progress sources never fall back to an ordinary AI reply. The dashboard reports pending delivery confirmations. Check the corresponding `reply:<inbound_message_id>` or `follow-up:<job_id>` receipt before finishing a confirmed delivery or manually releasing a confirmed unsent one; never blindly replay uncertain deliveries. This favors avoiding duplicate customer promotions over automatically recovering ambiguous sends.

## Verification

Run `npm test`, `npx tsc --noEmit --incremental false`, and `npm run build`. SQL verification uses the database connection already configured for this project:

```powershell
node --env-file=.env.local scripts/verify-pricing-experiments-sql.mjs
node --env-file=.env.local scripts/verify-pricing-day-sequence-sql.mjs
```

The verifier rewrites all new objects into a unique scratch schema, applies the migration twice, tests balanced/sticky allocation, four-arm catalog balancing per duration, changed-length quote snapshots, sequential offers, gap/window/staff stops, pause, tags, outcome attribution, run history and Page isolation, then rolls the entire transaction back. It does not touch customer rows or invoke Messenger workers.

Apply `202610220003_chatbot_pricing_day_sequence.sql` after the base pricing migration to install daily rotation. The second verifier applies both migrations in an isolated transaction and checks the full-day hold, daily spacing, days 2/3/5, response-window waiting, returned customers, exhausted sequences and service-only permissions. The upgrade preserves existing runs, catalogs, metrics and bot switches. Do not reapply the base migration alone after this upgrade because it contains the earlier function definitions.

The release helper previews the configured commercial Pages by default. It verifies the current knowledge source, preserves a backup outside Git, installs only additive schema with `--apply-schema`, and starts the four approved catalogs with `--activate` only after the deployed authenticated presets API verifies the exact packages. Activation is idempotent for an identical run and refuses to replace an owner-edited run. Bot settings, Page switches, existing customers, and knowledge documents remain unchanged.

```powershell
node --env-file=.env.local --import tsx scripts/release-pricing-experiments.mjs
node --env-file=.env.local --import tsx scripts/release-pricing-experiments.mjs --apply-schema
# Deploy the application before activation.
node --env-file=.env.local --import tsx scripts/release-pricing-experiments.mjs --activate
```
