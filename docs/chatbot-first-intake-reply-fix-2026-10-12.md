# First-intake reply correction

Live checks found many new-stage contacts marked as a Messenger staff handoff before the bot attempted its first reply. For contacts without a saved bot state, the history detector had no intake boundary and treated old staff mobile messages as current handoffs. The stage worker could create the same false stop while inspecting historical messages.

The first incoming message now supplies the boundary when an intake state does not yet exist. Reply delivery uses that inbound anchor too; the worker uses the contact's latest inbound timestamp or its current run time, and follow-ups use their inbound anchor. Existing intake boundaries and saved staff ownership remain effective. Explicit lead-stage changes and orders remain durable even if they predate the first intake.

Meta's exact administrative notice `This message was automatically moved to spam.` is excluded from staff-echo detection. Other unattributed Page messages remain protected as possible staff replies.

## Existing false stops

`scripts/reconcile-false-chatbot-stops.mjs` is read-only unless invoked with `--apply`. It inspects first-intake manual stops created in the past 48 hours on enabled Pages, restricted to new-stage Messenger ownership and contacts with no saved bot reply. It checks bounded live history and preserves terminal events, current staff replies, unattributed Page messages, opt-outs, refusals, and uncertain/unavailable histories.

The read-only scan examined 574 contacts and identified 220 whose only staff replies preceded their first intake. Fifty checked histories retained lead-stage/order/current handoff signals, 289 retained current or unattributed Page messages, and 15 retained customer opt-outs or refusals.

Eligible records are rechecked before restoration, backed up in the parent workspace's ignored `data/` folder, and updated with timestamp conditions in a transaction. Concurrently changed records are skipped. Restoration clears the false stop and returns the new-stage contact to system ownership, without sending Messenger messages or replaying old inquiries.

Production read-back confirmed more than 190 of the original false-stopped contacts active again or completing bot intake. A resumed scan restored 68 additional verified contacts after a database connection interrupted the first repair; 19 remaining scoped records retained current/unattributed Page messages or refusal evidence. Seven transient Messenger read failures were retried successfully and preserved their current Page-message or opt-out protection. The repair now updates both locked snapshots in one atomic SQL statement, also compares the latest inbound timestamp, and saves progress after each successful change.

The deployed bot recorded more than 1,000 successful replies after release. Historical delivery records also retain eligibility cancellations and a Meta thread-control rejection; the repair does not force ownership of another application's conversation.

Regression checks cover old staff messages before the first inquiry, current staff handoffs, durable terminal stages, automatic spam notices, and delivery eligibility. All 546 tests across 76 files pass, plus TypeScript and targeted lint checks. The full test run used a 20-second test timeout to avoid a cold module import timing out and contaminating the following test. No database schema migration is needed for these changes.
