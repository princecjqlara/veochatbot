# Deterministic lead-data reconciliation

Historical lead repairs run directly against retained Messenger evidence and
read-only Graph responses. They never call OpenRouter, generate customer replies,
or turn a lead stage into a verified cash amount.

1. Run `audit-historical-leads.mjs`. The audit checks full archived histories,
   exact customer/Page identities, source cutoffs, first inquiry messages and
   administrative stage notices. Private manifests retain source paths and SHA256
   hashes. Partial or unavailable histories do not establish a first inquiry.
2. Run `repair-historical-leads.mjs --preflight`, then `--apply`. Batches contain
   at most 250 contacts and retry serialization/lock conflicts. Each batch checks
   the source hashes again and commits atomically. Completed batch receipts and
   private database journals make an interrupted run reviewable and repeatable.
3. The repair installs migrations `202611020008` and `202611020009`. A transaction
   flag suppresses AI-summary queueing only during historical repairs. Normal
   future stage changes continue to enqueue summaries. Historical Meta notices
   establish conversion timing even if they arrived after a newer local stage;
   `applied` records local synchronization order, not whether the event happened.
4. Newer local decisions and explicit resets are retained. Earlier notices add
   history tags and evidence without overriding those decisions. Existing tag
   assignments, bot settings, summary jobs, verified payments and ad spend must
   remain intact. First-inquiry refinements preserve an identical first-message
   ad origin; a genuinely earlier different message does not inherit a later ad.

`collect-lead-reconciliation-sources.mjs --list` checkpoints accessible inbox
indexes for all stored Pages. `--histories` reads full message pagination for
known contacts whose retained evidence is missing or older than inbox activity.
Sources are compressed locally. Failed/partial histories remain unavailable;
they do not supply zero leads or conversions. Page access errors are retained
separately and require valid Page permissions to finish those portions.

`run-deterministic-lead-backfill.mjs` supervises collection and incremental source
repairs after the retained-history repair succeeds. It prioritizes active chatbot
Pages, checkpoints each committed batch and skips source hashes already recorded
in the private repair journal. Live source audits use `--live --only-new` and
repairs use `--audit-dir=.vercel/historical-leads/live-audit`. The same deterministic
projection parser extracts first inquiries and Page payment acknowledgements;
existing reviewed receipts are retained when their exact message is still present.
No ledger receipt is generated from those acknowledgements.

Progress is stored in `.vercel/historical-leads/background-status.json`. A run
with unreadable Pages finishes as `completed_accessible_sources`, preserving the
Page errors and missing coverage. A lost connection stops safely and the retained
checkpoints can be resumed. Collection backs off or stops before consuming the
Page/app capacity needed by live activity.

`verify-historical-leads.mjs` independently compares all matched archived notices
with the saved event ledger and smart-tag assignments. It also checks the repair
receipts for zero AI calls and zero newly queued summary jobs. Calendar browser
fixtures distinguish total leads, linked leads, current Converted stages and
confirmed customers, so an unknown ad source cannot hide a confirmed customer.

The report distinguishes first-inquiry customer cohorts, current pipeline stages,
documented payment confirmations and Meta messaging-conversation metrics. A
returning conversation is not automatically a new unique customer acquisition.
Receipt amounts and platform-attributed purchases retain their separate meanings.

Audit and repair receipts belong under ignored `.vercel/historical-leads`.
Credentials are supplied through an ephemeral environment file and removed after
verification. Do not commit raw histories, access tokens or customer details.
