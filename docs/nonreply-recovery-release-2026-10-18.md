# Recover replies after database outages

Commercial sa Negosyo Media's bot and split messaging were enabled. Its unanswered inquiry from `2026-10-17T19:01:47Z` had a failed reply event with `canceling statement due to statement timeout`. Live Messenger history had no Page reply. When the database recovered, the polling worker's 15-minute lookback continued to exclude this message.

Recovery now looks for unanswered customer messages within the normal 24-hour response window, bounded by each Page's explicit recovery enrollment time. It keeps the real message ID and timestamp, ignores conversations already answered by the Page, and retains sent/partially delivered/in-flight deduplication, retry bounds, handoff, opt-out, hold, ownership, and per-bubble delivery checks. It continues to dispatch at most one actual incoming message per leased Page per tick.

The recovery worker also checks the saved reply outcome after an HTTP 200 webhook acknowledgement. A retryable failure without any delivered message remains failed/retryable instead of being marked done. Partial delivery is not replayed.

All 835 tests passed, including new outage recovery, response-window expiry, and HTTP-200-without-delivery tests. TypeScript and scoped ESLint passed. The pending form incentive/sentence splitting prompt update completed across all 12 Pages after database connectivity recovered; settings read-back passed with zero stale eligible reminder revisions. The authenticated Commercial sa Negosyo Media conversation preview passed FAQ, incentive, intact form, separate next question, partial details, completed summary, free-script handoff, and no fee.

Deployment `dpl_7zCFB4haUEkED77w37fCgdp2r6nD` passed the production build and is promoted to `https://veochatbot.vercel.app`. The dashboard, webhook handshake, and signed empty webhook checks passed. The previous deployment is `dpl_GpZJGHJsWoFPDDQ29pF17cRTVxsj`.

The regular worker retried the known inquiry on October 18 at 03:20 UTC, but the delivery guard cancelled it before sending. Messenger history rounded its timestamp to `19:01:47.000Z`; the signed webhook had stored `19:01:47.825Z` on the contact. The guard therefore saw an apparently newer incoming message, even though this was the same message ID.

On the owner's subsequent instruction to turn every bot off first, all 12 Page chatbot switches and all inbound-recovery switches were disabled. The operation cancelled 127 queued or processing bot reminders, with a backup outside the repository. All switches were read back as off. Independent campaign/workflow settings and contact holds, stops, and collected answers were retained. No bot is to be reenabled without a new owner instruction.

The timestamp correction adds nullable `chatbot_reply_events.inbound_at` through migration `20261018_001`. New reply claims save the original signed webhook timestamp. Recovery uses that timestamp only for the exact message ID and matching whole second, retaining the original millisecond comparison in the delivery guard. A genuinely newer message in the same second still cancels stale delivery.

The maintenance script repaired only the known historical inquiry's missing timestamp. It required every bot and recovery switch to be off; live Graph history to contain exactly one customer message, the same saved message ID, and no Page replies; and the locked contact to retain the same original timestamp. It changed no reply status, retry count, contact state, or schedule and dispatched no message. The previous value was backed up outside the repository.

All 841 tests, TypeScript, and scoped ESLint passed. Regression checks include exact timestamp recovery, rejection of mismatched saved timestamps, cancellation on a newer inbound in the same second, and respecting a Page being disabled during an in-flight history read. Saved-prompt read-back passed all five fields on all 12 Pages with all bot/recovery switches off and no remaining queued chatbot reminders.

Timestamp deployment `dpl_HLPwFngQhp9j5XMEZLcHD3GwbZFT` passed the production build and was promoted to `https://veochatbot.vercel.app`; inspecting that domain confirmed the deployment is Ready. The previous deployment is `dpl_7zCFB4haUEkED77w37fCgdp2r6nD`. Dashboard health, webhook handshake, signed empty webhook, and Data API access to the new timestamp column passed.

The authenticated production preview for Commercial sa Negosyo Media passed with `enabled=false`: brief pricing FAQ, free incentive, intact four-field form, immediate separate question, partial answers, a fresh missing-field question after an ignored question, a contextual reminder, completed two-group summary, free-script handoff, no free-output fee, scope-based paid pricing, and the free choice when no request had been selected. These are admin previews, not Messenger sends. A final database read confirmed 12 configured bots, zero enabled bots, zero enabled recovery switches, and zero queued/processing/manual-ready chatbot reminders. The historical inquiry remains failed and unsent by design; its exact timestamp is ready for a future authorized retry.

Live customer delivery remains intentionally untested while every bot is off. No customer messages were sent by the maintenance or verification scripts. Bots remain off until the owner explicitly asks to turn them on.
