# Contact profiles and payment records

Open a contact name in Contacts or Pipeline to see Overview, Conversation,
Payments, Timeline and Projection. The contact list keeps the core columns visible;
extra timing columns and advanced filters can be expanded. Tags opens with manual
tags, with separate views for automatic stage history and other system tags.
Existing tags and assignments are preserved.

## Conversation analysis

An applied Facebook lead-stage decision queues a full conversation review even
when the chatbot is disabled. Opening a profile without a summary also queues a
review; Refresh analysis requests a new read. The minute cron processes two jobs
at a time. Long conversations checkpoint message pagination and analysis chapters
across runs. A snapshot is published only after all messages returned by Meta have
been read and analyzed. The previous snapshot remains available during a refresh
or source failure. The screen shows its source date and whether newer activity exists.

Summaries use GPT-6 Luna through OpenRouter with strict structured output. Each
displayed AI fact or answer must cite a real message and matching excerpt.
Generation uses compact local references for opaque Facebook message IDs, then
restores the exact IDs before checking and saving citations. This keeps long-history
chapter merges small without weakening source validation.
Customer needs and form answers require customer-authored evidence. Required
answers extracted from the conversation appear alongside saved form answers;
saved answers win when they disagree, and conflicts and answer history remain
reviewable. Analysis does not change bot state, lead stage, or financial records.

The profile includes purpose, preferences, business details, requirements,
purchases mentioned, problems, objections, suggestions, promises, and customer
questions. The question count groups repeated wording; it is not a count of
semantically unique topics. Attachments are counted, but their contents are not
financial verification. Deleted messages, unavailable history and inaccessible
Pages cannot be reconstructed. A Meta permission error requires reconnecting the
Page with an authorized administrator.

## Orders and verified payments

There is no connected bank or payment-provider ledger. Staff record an order,
then verify each actual deposit, balance, full-payment or refund transaction
against their payment records. Each payment requires an amount, currency, actual
date, transaction reference and explicit verification. Active transaction references
are unique within a Page. Retry IDs prevent accidental duplicate submissions.
Corrections void the original payment with a reason and preserve the audit trail.

Missing records mean **not verified**, not unpaid. Customer claims, receipt-like
messages, Page acknowledgments, Meta invoice requests, stages and tags never
become verified revenue automatically. Conversation evidence is displayed
separately. Totals use integer minor units and keep currencies separate. An
order's payment status is computed from net transactions, not the payment-kind
label. Purchase counts include only orders with recorded verified receipts;
unallocated receipts appear in totals but not purchase counts or order balances.
These counts describe the ledger's coverage, not an inferred lifetime total.

The journey includes the earliest verified/observed customer inquiry, actual stage
events, orders, verified payments and refunds, chat evidence, attributed follow-ups,
and referral/ad touches. Timings use actual timestamps. Inquiry-to-payment timings
start at the first known inquiry, not an inferred new sales cycle for each repeat
order. Only follow-ups with exact stored attribution are counted. An unknown
originating ad stays unknown; a later ad click is not relabeled as the origin.

## Projections

The existing supported-Page model forecasts a payment/deposit acknowledgment in
chat. It does not forecast bank settlement, balance payment or repeat purchases.
A full profile read refreshes the forecast's conversation evidence and removes
payment acknowledgments no longer present in the replacement source. A known
earlier inquiry missing from a refresh prevents that source being marked complete.

Forecast comparisons require both the issue time and source cutoff to precede
the outcome. A prediction generated after conversion is not presented as a past
forecast. Chat acknowledgment timing is compared with the existing forecast
target; staff-verified payment timing is displayed separately. This update improves
source freshness and valid comparisons; it does not retrain or recalibrate the model.

## Operations and verification

Apply `202611020004_contact_profiles.sql` before deploying the new routes. All new
tables use RLS with server-only access; each HTTP operation checks authentication
and Page membership, and writes require a same-origin request. Financial RPCs
also verify the actor's Page membership and contact/order scope. The worker never
sends customer messages. The cron requires `CRON_SECRET`.

Run the Vitest suite, TypeScript check, production build, and
`node scripts/verify-contact-profile-browser.mjs http://localhost:3100` against a
running build. The browser check uses a fresh isolated Chrome profile and synthetic
API fixtures; it never creates financial records. Release scripts support a
transactional schema preflight and read-only production API verification.
