# Deterministic lead-data reconciliation

Historical lead repairs run directly against retained Messenger evidence and
read-only Graph responses. They never call OpenRouter, generate customer replies,
or turn a lead stage into a verified cash amount.

## Connected-Page refetch and whole-system coverage

The refresh worker probes current conversation access and bulk-reads only
connected Pages with an app membership. Rejected connections are excluded;
temporary failures remain unverified. Pages with zero stored contacts are
included so their first conversations can be discovered.

An explicit refresh request is recorded in ignored
`.vercel/historical-leads/connected-refetch-request.json`. Its `requested_at`
must be an ISO timestamp. Histories saved before that timestamp are fetched
again. The same timestamp survives restarts, allowing newly completed reads to
be reused. Inbox-head refreshes update existing conversation timestamps while
retaining unfinished pagination. A matching old inbox ID is never enough to
declare a cached history current.

The supervisor enables `--discover-new-contacts` on inbox collection. This mode
inserts verified, previously unknown Page/customer identities and journals them
in `app_private.lead_contact_discovery_journal`. Repeated reads preserve existing
names, tags, stages, dates and bot controls. First inquiry dates remain unknown
until full-message evidence establishes them. Discovery aborts if it queues AI
profile work. Running the collector without this flag remains read-only in the
database.

`refetch-connected-ad-data.mjs` refreshes connected-Page ad previews and, when
the worker has a Facebook user token in `META_USER_ACCESS_TOKEN`, verified ad
inventory and daily delivery/spend. The default reporting period is the previous
month through today; explicit `--from` and `--to` dates may cover up to 94 days.
Only creatives proving ownership by a connected Page can be imported. Missing
Insight rows become reported zero only after a complete filtered account report.
Failed reports retain unknown coverage. Budgets and payment records are unchanged.
The worker records unavailable ad-account access separately from Page access;
the signed-in calendar can use its own Facebook session for existing ad imports.

`audit-retained-system-data.mjs` reads all recognized raw-history export folders,
the retained repair manifest and the newer Graph archive. It verifies hashes,
deduplicates Page/customer identities, rejects partial or undated evidence, and
reports coverage against the last saved full database inventory. Older export
contact IDs may represent unsynced discoveries; they are not proof a contact
exists in the live database. Raw sources and the generated registry stay ignored.
This offline audit never certifies current connections, current database totals,
bank receipts or complete ad inventory. Its dated coverage counts must not be
presented as a freshly measured live backlog.

Source collection, new-contact discovery, ad inventory, daily spend, verified
receipt amounts, full profile reviews and current database reconciliation are
separate checks. Completing a 250-contact repair batch or checking a saved history
does not complete the whole system.

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
