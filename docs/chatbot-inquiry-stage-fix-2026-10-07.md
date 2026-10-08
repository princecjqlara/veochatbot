# Inquiry replies and lead-stage delivery checks

## Final behavior

Messenger inquiry buttons now reach the chatbot, including postbacks without a message ID. Those events use a stable key from the Page, contact, timestamp, and button payload so redelivery does not create another reply. Eligible first text inquiries go directly to the chatbot instead of being consumed by a welcome message. Button interactions also refresh inbound activity and cancel superseded follow-ups.

Page-originated lead-stage system messages save the stopped chatbot state and cancel follow-ups as soon as their webhook arrives. This includes Qualified, Not Qualified, Converted, Order Created, Contacted, Intake, and custom stages. Nonterminal or custom Messenger stages save a manual handoff stop; they do not receive paid/conversion outcome tags. Customer-written stage-like text remains ignored. Before each reply/follow-up bubble and media carousel, delivery checks saved contact status, Page settings, job cancellation, and fresh Messenger history. Saved eligibility is checked again after the Messenger read to catch stops made during that request. Meta reads explicitly bypass caches.

Dashboard stage edits now persist the stopped bot state and cancel pending, processing, and manual-ready follow-ups before updating the visible stage. Any stage with a manual or Messenger source blocks bot replies and follow-ups. Automatic intake stages continue normally. Chatbot pipeline updates cannot replace a human source, and conditional stage/source filters protect against a handoff during a pipeline update. The explicit trial reset clears bot state and uses a system source to reopen intake.

Temporary history, state, and claim errors request webhook redelivery. A failed reply claim can be reacquired atomically only when no outbound message was recorded. Partially delivered replies and follow-ups are not replayed. Customer details are saved before delivery; the generated intake-completion stop is saved after delivery. Conditional writes prevent intake completion and completed-photo updates from replacing a concurrent human stop.

Normal inquiry replies answer directly, normally in 15-40 words with at most one necessary question. The formatter enforces 320 characters total and one message by default, at most two when explicitly configured. Exact duplicate message parts are combined. Both enabled Pages' normal-reply instructions were revised to reduce repeated questions, filler, pressure, unnecessary name mentions, and excessive emojis.

## Follow-ups restored at the user's request

Onset Media Agency and Azshinari retain their original follow-up schedules: 60, 240, 720, and 1380 minutes, then days 2, 3, 5, and 7 at the contact's best time. All saved follow_up_* settings, including the follow-up prompts, enablement, and media settings, were restored from the original backup. The generator retains its previous output limit of 320 characters and up to two bubbles, with the original split/part settings. The shorter normal-reply formatter does not change those follow-up limits.

An earlier frequency reduction cancelled 656 queued follow-ups. Eligible future reminders were restored. Overdue reminders were not released as a catch-up burst, and stopped contacts and superseded inbound sequences remain ineligible. Follow-ups still respect terminal lead-stage stops, opt-outs, and intake completion.

The original settings backup and restoration results remain outside the repository in veobot/data/chatbot-settings-before-short-replies.json and veobot/data/chatbot-follow-up-restore-result.json. scripts/restore-chatbot-follow-ups.mjs is an administrative write script requiring that local backup; do not run it as a routine check. The two verification scripts are read-only except for a signed empty webhook request containing no customer events.

## Verification and limits

All 432 tests across 72 files passed after restoration. The October 8 handoff correction expands this to 463 passing tests across the same 72 files. The Windows sandbox blocked esbuild's subprocess, so this verification compiled the TypeScript tests with tsc and ran Vitest against those files with esbuild disabled and symlink resolution preserved. Coverage includes first inquiries, button inquiries, all explicit stage echoes/history events, changes during generation or a Messenger read, stops between bubbles, cancellation of claimed jobs, safe retry claims, partial delivery, dashboard handoff persistence, explicit trial reset, and concurrent state/pipeline writes. TypeScript validation and ESLint checks passed, with existing dashboard lint warnings.

Live checks verified the webhook handshake, signed empty webhook handling, dashboard availability, and both Pages' restored follow-up settings. A simulated generation produced one 242-character inquiry reply without Messenger delivery. No test messages were sent to real contacts.

Both Pages retain their configured 46% detail-completion target. Later inquiries from contacts already stopped for completed intake, qualification, refusal, or opt-out still require human handling. Two reviewed failed reply records were Meta error 551 (recipient unavailable), which the bot cannot resolve. Older-history pagination retains bounded, fail-closed behavior when Meta history cannot be checked fully.
