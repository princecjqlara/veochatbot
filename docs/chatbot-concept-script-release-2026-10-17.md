# Concept/script intake and nightly human-handoff continuation

The commercial-video bot now separates required form completion, the customer's requested next step, and staff ownership. Free pre-production offers are a concept or script. Relevant existing portfolio examples and the shared knowledge library remain available.

The required fields are Business Name, Business Location, Goal ng video, and Contact Number, all four required. A full form is constructed by the application as one Messenger message. Partial answers and corrections are preserved, and optional discovery does not count toward form completion. Explicit legacy aliases map existing business names, locations, video purposes, and phone numbers into the new schema.

Replies, follow-up generation, intake extraction, preview, and nightly review share the form/intent policy. Follow-ups continue when the form is incomplete OR there is no clear request for a commercial video, free concept, or free script. When both form and request are complete, intake hands off to the team. The old percentage stop and '+3 more details' continuation remain available only to generic Pages.

Normal staff intervention immediately pauses chatbot activity and invalidates older jobs. Explicit staff holds/stage changes, opt-outs, refusals, and durable outcomes remain protected. Temporary takeovers become due for review at the next 23:59 Asia/Manila cutoff. A takeover at or after 23:59 belongs to the next day's review. Workers refresh all bounded readable history, preserve evidence-backed request intent, and atomically compare state, staff activity, customer inbound, Page policy revision, and automation epoch before resuming.

A reviewed restart acknowledges the original takeover without erasing its history. Newer staff messages still stop delivery. A replacement sequence contains at most one immediate continuation plus eligible future configured reminders, using the original inbound permission anchor. Missed reminders are not replayed. Reviews do not extend message-send permission. The due time is 23:59; actual worker execution can follow it according to queue load.

## Validation

- 720 tests across 83 files pass, including all four form/intent combinations, intact forms, knowledge and offer validation, late facts, takeover during generation, epoch/config changes, and resumed follow-ups.
- 51 checks execute the real migrations and RPCs in an isolated PostgreSQL schema. They cover the OR rule, Philippine cutoff boundaries, incoming and existing durable holds, settings revision liveness, transaction rollback, and simultaneous claim workers. The scratch schema is removed after verification.
- TypeScript and ESLint for changed application/test files pass. The local production build passes; existing unrelated dashboard warnings remain warnings.
- Reply and follow-up generation previews pass for all 12 related Pages using live knowledge, with no Messenger messages sent by the previews.

## Release procedure and recovery

`scripts/release-commercial-video-intake.mjs` previews its Page scope by default. `--apply-schema` applies the additive precursor and new migration with the feature disabled. It retains the old four-column reminder uniqueness constraint during deployment for compatibility with the previous application. `--apply-settings`, used after the new application is live, backs up the scoped configurations, active states, queued jobs, business document, and original chunks to the parent workspace's ignored `data/` directory. It removes the old constraint, enables the scoped policy, migrates active detail aliases in bulk, preserves future reminder cadence and Page enable/follow-up/knowledge toggles, and replaces only the business document's updated content/chunks transactionally. Portfolio documents are preserved.

The read-back verification checks the four fields, 100% target, 23:59 schedule, enable/follow-up/knowledge settings, reminder cadence, and preserved library. `scripts/preview-commercial-video-intake.mjs` regenerates Page previews without contacting customers. `scripts/verify-chatbot-release.mjs` checks webhook verification, a signed empty webhook, and dashboard availability without customer events.

For recovery, keep the compatible application and additive schema. Disable the scoped policy and restore only the changed Page settings/business-document chunks from the matching backup, comparing current revisions before restoration. Preserve newer customer facts, opt-outs, staff activity, and sent-message records. Do not replay canceled jobs or restore entire contact snapshots over newer conversation activity. Returning to an older application additionally requires restoring the older job-key compatibility contract; an alias rollback alone is insufficient.

Historical stopped contacts are not bulk-reopened. New temporary takeover tracking starts from policy activation; staff-confirmed historical ownership and closed outcomes remain intact. No Git commit or push is part of this release.

## Production result

Deployment `dpl_CjzcmG78U1BkPNxfZJhcNhZHfab1` is ready and promoted to `https://veochatbot.vercel.app`. An explicit Vercel team scope resolved the CLI's initial promotion scope mismatch.

Both migrations are applied. Activation updated 12 related Page configurations, migrated 1,306 active states' detail aliases, and reindexed the existing business document into 20 chunks. Production read-back confirmed all required fields and the 23:59 OR rule, nine enabled Pages, unchanged Page/follow-up/knowledge toggles and reminder cadence, and all 478 shared knowledge/portfolio documents retained. Existing stopped contacts were preserved.

Backup: parent workspace `data/commercial-intake-backup-2026-10-17T05-13-39.952Z.json`. Production read-back and preview artifacts are `data/concept-intake-production-readback.json` and `data/concept-intake-page-previews.json`. They contain business settings and preview data and are kept outside the repository.

Production webhook verification, a signed empty webhook, and dashboard availability pass. These checks and the Page previews send no customer messages. The nightly cutoff is configured and covered by isolated database tests; a live 23:59 worker run is not claimed as observed during this daytime release.

The final read-only runtime check found three follow-up jobs marked sent and 40 pending jobs updated since activation, with no failed status in that window. No new inbound reply events were available in that check. These counts establish activity, not the content or final customer receipt of individual messages.
