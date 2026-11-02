# Conversation and Page access audit — 2 November 2026

The database audit covered 293,730 contacts, 17,528 tag assignments and 800 tag
definitions at its initial read. It found no orphaned assignments, cross-Page
profiles or ad origins, unsupported `verified_inline` ad origins, or disagreement
between applied Messenger events and the current Messenger-owned CRM stage.

All 38 saved full-conversation reviews were reconciled against fresh, fully
paginated Facebook history. Their 4,698 saved source messages matched exactly
through each review's cutoff. One later message was outside the saved cutoff.
All 1,118 summary/fact/answer citation items referenced existing messages with
matching excerpts and the required sender role. This verifies source integrity;
it does not prove every interpretation in an AI paraphrase.

The other 293,692 contacts had no full saved review at that read. Database
consistency was checked for them; their complete historical conversations and
manual tag meanings have not been individually certified. Inaccessible Pages
cannot be reconciled with their current Facebook history. Missing payment and
spend records remain unverified, rather than assumed unpaid or zero cost.

## History repaired

The full-history check found six notices outside the incremental scanner's
history window: one old Qualified notice for SmartMenu and five order notices
for SAMA KANA MEDIA. Their current stage labels were already correct. The repair
recorded those six events, supplied the missing latest-event reference, added
one missing history-tag assignment, and retained every existing tag assignment.
No financial records or customer messages were created, and chatbot configuration
was unchanged.

The follow-up audit covered 293,734 contacts and 17,536 tag assignments (the
normal scanner continued adding records during the audit). All 48 observed
stage/order notices were then present, with zero missing history tags, current
stage mismatches or latest-event reference mismatches. All 38 saved reviews
still matched their complete Facebook histories through their cutoffs.

Full profile reviews now reconcile saved Page-authored stage/order notices using
the production stage parser and the same timestamp-ordered, idempotent RPC as
the scanner. Explicit history resets remain respected. Older events add history
without rolling back newer stages. An order notice does not verify payment.

Three apparent stage-reference discrepancies in the first audit comparison were
later Order Created notices following Converted notices by a few seconds. The
audit now uses the production parser, including order notices, rather than a
lead-notice-only expression.

## Eleven inaccessible Pages

Fresh read-only conversation requests succeeded for 35 of the 46 saved Pages.
The following eleven requests failed:

| Page | Current Facebook response | Action needed to restore access |
| --- | --- | --- |
| Customized Socks / Direct Manufacturer PH | 190; required Page permissions missing | An authorized Page owner must restore the app's Page permissions. |
| Idle Team of Experts | 190 / 460; session invalidated by password/security change | Sign in with the authorized Facebook account and renew Page authorization. |
| JP Luxe Estate | 190 / 460; session invalidated by password/security change | Renew authorization with the authorized account. |
| Kanta mo, kwento mo | 190 / 460; session invalidated by password/security change | Renew authorization with the authorized account. |
| Loki Media | 190 / 492; Page role or required two-factor access missing | Verify the connecting account's Page role and business two-factor requirement, then renew authorization. |
| Looking for VE | 190 / 460; session invalidated by password/security change | Renew authorization with the authorized account. |
| Negosyo GPT | 190 / 460; session invalidated by password/security change | Renew authorization with the authorized account. |
| Sam's Culture Gym | 190; required Page permissions missing | Restore the app's Page permissions. |
| The Beauty Vhell Hair Nails Lashes Spa | 190 / 459; Facebook login checkpoint | Complete Facebook's login instructions, then renew authorization. |
| WebMo | 190 / 460; session invalidated by password/security change | Renew authorization with the authorized account. |
| Zeus Media | 190; required Page permissions missing | Restore the app's Page permissions. |

All eleven still have saved Page records, at least one app membership, and stage
sync enabled. No successful Page-disconnect/deauthorization action was found in
the app's activity history. Looking for VE has a `page_access_revoked` record:
the database function records removal of a delegated teammate's VeoBot access,
not revocation of the Facebook connection. These facts do not establish whether
someone intentionally changed access on Facebook itself. No Page was reconnected,
disconnected, archived or removed during the audit. Loki's enabled bot remains
blocked by its Facebook access error.

## Reproduction

Run `node --env-file=<production-env> scripts/audit-conversation-data.mjs` with
authorized database access. The audit is read-only and stores its receipts under
ignored `.vercel/conversation-data-audit`; credentials and raw chat text are not
included in the report. Its local configuration baseline is sensitive and must
remain ignored. `repair-audited-stage-history.mjs` requires a recent exact Meta
reconciliation and reparses each saved Page-authored notice. It rolls back by
default; `--apply` commits the additive repair transaction.

The heat map now defaults to profit after salary and ads. All selected metrics
use red below zero, green above zero, white for verified zero and gray for
unavailable values. Profit/ROAS labels include a sign, and the legend explains
the colors. Positive expense amounts remain expenses.

Validation passed: all 1,279 Vitest tests, TypeScript, production build, and
desktop/mobile browser checks for calendar economics, red/green/zero/missing
colors, signed labels, later-payment cohorts, source citations and tag views.
Browser checks created no live financial records or customer messages.
