# Manawari Studios reply repair

Manawari's chatbot and follow-ups were enabled, with trial restrictions disabled. The owner's latest price inquiry appeared in Messenger without a bot reply. A retry through the normal handler exposed a durable `Lead stage set to Not qualified` notice from September 15, 2025. Existing reset controls deleted the saved state but did not acknowledge historical Messenger stage notices, so history scans immediately stopped the chat again.

Explicit owner resets now use one service-only database function to retire the previous intake/reviews, cancel its queued jobs, increment the automation epoch, and reset the pipeline. A persisted `messenger_history_reset_at` boundary acknowledges older dated Messenger notices. Inbound handling, final delivery guards, follow-ups, tagging scans, and continuation reviews share this boundary. New stop events and events with unavailable dates continue to block delivery. Ordinary inbound messages and nightly resumes do not create the boundary. The original customer inbound timestamp and permission window are preserved.

Migration `202610170002_explicit_chatbot_reset.sql` is applied. Deployment `dpl_AKkcYNK6PywmkVxTMxPcJYxgB59c` passed its production build and is promoted to `https://veochatbot.vercel.app`. The Page's existing messages/postbacks/echo subscription was backed up, refreshed, and read back. No other contacts were reset.

Validation: 723 tests across 83 files, TypeScript, and targeted ESLint pass. `scripts/verify-chatbot-reset-sql.mjs` executes the real reset function against temporary copies in a rolled-back transaction, checking Page scope, state/job/pipeline behavior, epoch invalidation, unchanged inbound timing, and RPC privileges. Production webhook handshake, signed empty webhook, and dashboard checks pass.

The owner's test contact was backed up and explicitly reset. Its real existing price inquiry was retried using its original message ID and timestamp through the ordinary signed partner handler. The normal reply event is `sent`, and a matching Page reply appears in live Messenger history at October 17, 2026, 15:14:56 Asia/Manila. The contact remains active. This verifies an actual bot send after reset; a subsequent organic inbound webhook has not yet been observed.

Scope-specific backups, diagnostics, the deployment log, and the live reply evidence are in the parent workspace's ignored `data/` directory. No commit or push was performed.
