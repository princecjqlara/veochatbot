# Chatbot handoff and subscription release

This release commits the staff-handoff and shared-media attribution corrections described in the Onset and enabled-Page audits. Staff replies stop chatbot intake and cancel queued bot follow-ups before delivery. API echoes are excluded from human-echo detection. Shared Drive media is attributed to the sending Page while knowledge lookup uses the shared library.

The release review also corrected two edge cases. The stage worker now applies the current intake start time when inspecting ordinary staff replies and takeover notifications, so older handoffs do not close an explicit intake reset. Explicit lead-stage and order events remain durable. Generic handoffs use a null terminal lead stage in interruption audit records, matching the database constraint.

## Enabled Pages and subscriptions

The seven enabled Pages are Commercial Mo Media Agency, Onset Media Agency, Azshinari, Manawari Studios, Loki Media, Vista Media Agency, and SAMA KANA MEDIA. All 31 configuration fields match Azshinari after excluding row and Page IDs and timestamps. All seven use its shared library of 478 ready knowledge documents; trial mode is off. First-day follow-ups are enabled and later-day automatic schedules remain empty.

Message-echo subscriptions were restored on the six older Pages while preserving their existing fields and other app subscriptions. Commercial Mo already had echoes enabled. Read-back verified `messages`, `messaging_postbacks`, and `message_echoes` on all seven. The contact-sync route previously refreshed subscriptions with only messages and postbacks, removing echoes again; it now includes echoes, matching connection and webhook-refresh routes. Both primary and partner app callbacks and signed routing probes passed. No current Page stage-sync errors were present.

Subscriptions and chatbot settings are persisted outside Git. Backups and verification reports are in the parent workspace's ignored `data/` folder. Commercial Mo has no Messenger conversations yet; its reply, sample-media, follow-up, and opt-out previews passed, but actual customer delivery remains unverified. No customer test messages were sent.

## Database migration audit

Compared the production migration ledger with 38 tracked versions referenced by 68 repository SQL files, and checked the release's required tables, columns, constraints, and indexes. One older migration was genuinely missing: `20260816_013`, resumable campaign pauses. Production lacked `pause_campaign_delivery` and still used a cancellation function that deleted pending recipients.

Applied `database/migration_resumable_campaign_pause.sql` in a transaction after backing up the previous function definition and permissions. Both pause and cancellation now preserve unsent recipients. Explicitly revoked anonymous and authenticated execution grants, including inherited default grants, while retaining service-role access. The standalone migration and initial-schema definitions include those revocations. Invalid campaign IDs verified both RPCs without changing campaign records.

The final audit found all 38 tracked versions recorded, with no missing checked tables or columns. No new chatbot schema migration is required for the handoff corrections.

## Validation

All 542 tests across 76 files passed for the handoff changes, including current-intake worker boundaries and schema-compatible takeover audits. The subsequent contact-sync subscription fix adds coverage for preserving echoes. TypeScript validation passed. Full lint passed with 15 existing dashboard warnings; targeted checks on the final changed handoff files passed. Production build and deployment records, post-release checks, migration audit, and subscription read-backs are retained in the ignored release artifacts.

The existing limitation remains: stage-only Business Suite edits that Meta does not expose cannot be inferred reliably. VeoBot stage changes persist the bot stop directly, and staff echoes and mobile-message history provide additional protection.
