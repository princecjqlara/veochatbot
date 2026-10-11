# Onset human handoff correction

The production deployment already included the earlier terminal-stage checks. A read-only inspection of 60 recent Onset conversations returned order notifications but no explicit Lead Center stage messages. Those reads cannot establish the actual Business Suite stage. A stage-only edit that Meta does not expose cannot be detected reliably by this application's public API integration.

The audit did verify staff mobile messages and the exact system notification `You took over this chat from your AI agent.` Both were missed by the previous stop detector. Staff text and attachment echoes were skipped without saving a chatbot stop. The new regression tests reproduced four failures before the change.

Staff echoes now save the stopped state and cancel pending, processing, and manual-ready chatbot follow-ups. API echoes with an app ID are ignored, including echoes that arrive before outbound attribution is saved. Known automatic messages are also ignored when Meta omits the app ID. Handoffs run before customer inquiries in the same webhook batch. If a handoff cannot be saved, the related inquiry is skipped and Meta receives an error so it can retry.

Live history checks request message tags and recognize Page-originated `source:mobile` replies, including attachments. Current API messages were verified as `source:web`; that tag alone does not imply a staff handoff. Ordinary staff messages and takeover notifications before the current intake's start do not close a newer intake or explicit reset. Explicit lead-stage and order stops remain durable. These checks run before each chatbot reply/follow-up bubble and carousel. The background worker uses the same detector.

Generic Messenger handoffs retain the existing lead stage and change its source to Messenger. Workflow follow-ups now honor that source even for nonterminal stages. Follow-up eligibility refreshes also include the stage source.

The dashboard explains that a stage-only Business Suite edit may not reach this application and that changing the stage in VeoBot saves the stop directly. This limitation remains; the change does not promise visibility into an unreported Meta stage or recall a message already accepted by Meta.

`scripts/reconcile-messenger-handoffs.mjs` is read-only by default. With `--apply`, it backs up each affected active state and queued jobs before saving a verified stop. It never sends Messenger messages. Audit reports and backups are stored in the parent workspace's ignored `data/` directory and contain no access tokens. The scoped Onset audit found two active chats with staff replies during their current intake. Older staff replies were excluded from repair.

## Release and verification

Both verified active Onset chats were stopped after their records were backed up. Three queued chatbot follow-ups were cancelled. Read-back checks confirmed stopped states, Messenger stage ownership, and zero remaining pending/processing/manual-ready jobs for those contacts.

All 524 tests across 74 files passed. TypeScript and targeted ESLint checks passed. The local production build passed; Vercel also built and typechecked the final deployed source successfully. Production deployment `dpl_2BvT7duDUygjHPy9W1hi2P5WLvHm` is ready and aliased to `https://veochatbot.vercel.app`.

Production checks passed webhook verification, a signed empty webhook request, and dashboard availability. The published chatbot dashboard asset includes the revised handoff explanation. These checks did not send test messages to customers. Source changes remain in the local working tree; no Git commit or push was performed.
