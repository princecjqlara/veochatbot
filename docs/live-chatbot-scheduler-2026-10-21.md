# Live chatbot scheduling

SAMA KANA MEDIA was enabled with a valid Page token, active Facebook callback and the required message subscriptions, but its recovery enrollment had never been checked after activation. The deployed Vercel project had zero cron definitions. The existing bot worker depended on an external follow-up/campaign cron invocation.

`/api/cron/chatbot` now runs every minute through Vercel. It requires the production `CRON_SECRET`, recovers missed incoming messages, refreshes live handoffs, checks intake continuations and processes due chatbot follow-ups. It does not run campaign workers. A temporary dependency failure is recorded and returns HTTP 503 while allowing the remaining bot phases to run.

Existing atomic claims and reply IDs prevent duplicate delivery when the external worker also runs. Existing guards still restrict recovery to enabled Pages, messages received after activation and the 24-hour recovery window. Every actual reply rechecks contact holds, Messenger stages, policy revisions and messaging eligibility. No contacts are reset and no other Page switches are changed by this release.

Check the live project's Vercel cron definitions for `/api/cron/chatbot` with schedule `* * * * *`, then confirm `chatbot_inbound_recovery_pages.checked_at` advances automatically and `last_error` remains null. Actual customer delivery is verified separately through `chatbot_reply_events`; an admin preview is not delivery proof.

Vercel sends the configured scheduler secret in the Authorization header as described in its [cron documentation](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
