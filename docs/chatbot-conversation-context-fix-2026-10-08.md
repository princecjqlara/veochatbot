# Price reminders and failed reply handling

Live read-only Messenger checks found price inquiries followed by the exact saved fallback: "thank you po, is there anything na want pa po nila ipadag-dag?". Direct generation and embedding requests both returned "Insufficient credits". The account credits endpoint confirmed a negative balance; the API key's separate spending limit was not exhausted. Restoring account credits remains necessary for AI replies and semantic knowledge searches.

Reply generation errors now propagate to the existing failed-reply record and webhook retry handling without sending the fallback, recording a successful answer, or completing intake. Empty or malformed JSON gets one additional generation attempt. Unusable results remain retryable instead of being sent as JSON or a generic acknowledgement. Valid silent opt-out and refusal decisions still stop the bot. The settings screen describes failed-reply handling in place of the obsolete fallback editor; the stored field remains compatible with existing settings APIs.

Normal inquiry context now includes up to 200 readable messages from the history already fetched for the lead-stage audit, including older pagination. Messages are deduplicated by ID and ordered chronologically when timestamps are available. The current customer request remains the last turn. Knowledge retrieval includes the current question, eight recent conversation turns, and known customer details, so short questions retain the package being discussed.

The normal reply prompt explicitly resolves price reminders such as "magkano na nga po", allows a requested earlier answer to be repeated, distinguishes package totals from deposits and balances, and answers questions before continuing intake. Unknown or conflicting prices still require confirmation. The follow-up generator, schedule, and saved follow_up_* settings are unchanged. Existing terminal-stage delivery stops remain in force.

Regression coverage checks overlapping and out-of-order history, quotes beyond the first 100 messages, package-aware knowledge retrieval, provider credit errors, invalid output, silent stops, and webhook failure recording without Messenger delivery. Live diagnostics and simulations sent no customer messages. Successful live AI answers must be rechecked after credits are restored.

All 491 tests across 73 files passed. TypeScript validation and lint checks passed, with the same 15 existing dashboard warnings. Read-only verification confirmed both enabled Pages still match the original follow-up settings backup.
