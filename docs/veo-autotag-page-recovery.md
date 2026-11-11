# Auto-tag verification and Page recovery

The November 11 live audit checked every one of the 15 enabled workspace Pages.
All had auto-tag enabled, matching token identities, the required messages,
postbacks and echo subscriptions, and readable conversations/messages. There
were no missing saved current-stage tags, missing saved history-event tags,
source-job errors or inbox-event errors at the audit snapshot.

Workspace webhooks and source checks already save stage history and tags. The
older messaging-auto-tag cron, however, returned a successful skip in workspace
mode. The cron now runs a dedicated bounded recovery scanner while preserving
the old worker for non-workspace mode. The recovery scanner:

- Fairly leases three Pages per minute independently of chatbot enablement.
  Claims enroll enabled workspace Pages, including Pages added after release.
  A Page's auto-tag setting controls its recovery scan.
- Reads a small updated-conversation batch, matches one Page-scoped participant
  to an existing contact, and accepts exact Page-authored notices since launch.
  It imports no transcripts, creates no contacts and invokes no delivery worker.
  Customer-written copies, pre-launch notices, invoice text and missing dates
  cannot silently establish a new verified stage.
- Resumes Page cursors with a five-minute overlap. A resumed older scan also
  checks the newest conversation edits. Repeated observations are deduplicated
  by Page/contact/message; older events cannot overwrite newer decisions.
  Deeper known-contact histories are delegated to the existing source queue.
- Restores missing current and older saved history tags idempotently, keeping
  manual/default tags. Qualified/Converted tags do not prove payment.
- Keeps cursor/watermark progress on failure, uses token-bound leases, backs off
  failed Pages, and reports partial failure rather than returning success.
  Missing contacts remain visible for identity sync while known contacts in the
  same batch are still processed. A failure on one Page does not stop others.

The private state table and RPCs are service-role-only. Owner/Team Leader status
reads use current tenant/Page permissions and exclude tokens, cursor contents
and customer messages. The Pages & connections screen shows each Page's latest
successful scan, first-scan pending, disabled, overdue, pagination or retry status.

The existing durable stage/history behavior remains independent of the old
seven-day last-inbound tagging rule. Recovery is limited to launch-period
observations, while already saved historical tags remain retained. No Meta
label, payment, salary, receipt or order is invented by a tag repair. The schema
release preserves existing rows, grants, login states and launch dates.

Meta can omit Business Suite administrative notices from readable history and
webhooks. A successful scan verifies accessible evidence, not completeness of
every Business Suite action. Required Page permissions must remain valid.

Validation covers real PostgreSQL tag reconciliation, Page scoping, lease fencing,
fairness, retries, cursor progress, secret suppression, actor checks, renderer
status states, exact stage evidence and existing webhook/manual/financial rules.
Production checks read every Page and observe ordinary scheduled scans without
sending a test Messenger or Telegram message.
