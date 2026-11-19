# Database storage protection

The earlier PostgreSQL incident included disk exhaustion during WAL startup.
Database size alone cannot measure that risk: WAL and other files also occupy
the data disk. The new project's baseline was about 89 MB of database data with
1.66 GB available on its 2.08 GB data disk. These are time-specific readings.

Migration `202611100001` adds an independent database cron job every five minutes.
It strips payloads from at most 500 completed webhook events older than seven
days, preserves duplicate-protection keys, and removes job execution logs older
than seven days. Queued/processing events, contacts, tags, knowledge, source
facts, sales, payments and financial history are retained. A shared advisory
lock prevents overlapping retention batches. Cleanup is independent of Vercel,
planning, Facebook and AI. Autovacuum thresholds are lowered for the event inbox
and contacts so dead tuple space can be reused sooner. No blocking VACUUM FULL,
database reset or replication-slot deletion is performed.

A Vercel cron separately checks Supabase's authenticated Metrics API every
minute. It reads `/data` available bytes (including filesystem reservations),
disk capacity and WAL size, and saves only one private health checkpoint. Missing
or failed metrics remain unknown/stale; database size never substitutes for disk
space. The checkpoint does not accumulate a new history row each time.

The owner sees storage details in Collection health and a dashboard notice when
attention is needed. Other workers cannot read infrastructure measurements.
Metrics older than 15 minutes and cleanup older than 20 minutes are visible
failures. The app warns when the data disk reaches 70% used or has 512 MiB or less
available. At 80% used or 256 MiB available, optional bulk syncs and enrichment
pause. A separate conservative 500 MB app database budget warns at 350 MB and
pauses optional growth at 400 MB. This budget does not assert a platform quota.

Optional work also pauses if monitoring or cleanup is stale. It returns a
retryable failure without acknowledging an unsaved batch. It resumes after
fresh measurements and cleanup establish adequate capacity. Normal inbound
collection, contacts, tags, reads and financial actions are not gated by this
optional-work check. Provider incidents and unlimited essential-data growth
remain possible; finite storage cannot guarantee perpetual availability.

Independent cleanup runs in PostgreSQL; physical-space monitoring runs in Vercel.
Both jobs must remain enabled. Monitor the owner notice and scheduler failures;
review retained business-data growth before reaching the app budget. This
release changes neither the account plan nor the single-database configuration.

Migration `202611200001` removes three redundant ordinary indexes. Contact
inquiry searches retain `idx_contacts_calendar_inquiry`, which has the same
three search keys plus the pipeline stage. Page identifiers and user emails
retain their unique indexes. The migration checks keys, ordering, collations,
included columns and constraints before removing anything. It changes no
business records, receipt images, retention periods or access rules.

For an existing production database, run
`node scripts/release-storage-index-consolidation.mjs preflight`, then `apply`.
The release removes indexes individually using the online operation before
recording the migration; it never falls back to blocking table maintenance.
Recheck owner storage health afterwards. Index consolidation reduces recurring
write overhead, but essential message metadata and duplicate-protection keys
still grow with real traffic. Space compaction should remain a supervised,
resource-limited operation rather than another frequent background job.

Migration `202611200002` narrows the completed-event cleanup index to
`received_at`. Long event keys remain unchanged in the inbox and its primary
key; they no longer need another copy in this working index. Cleanup retains
its seven-day policy, 500-row limit, row locking and event-key tie ordering.
The release command `node scripts/release-compact-retention-index.mjs preflight`
checks the live definition and a bounded read sample. `apply` builds the
replacement online with 16 MB maintenance memory and no parallel workers,
checks fresh host capacity, then swaps indexes without rewriting the table.
It verifies unchanged cleanup functions, duplicate protection and read results.

Automatic contact/name reconciliation runs every five minutes, offset from
other periodic imports. This reduces that scheduled worker from 1,440 to 288
invocations per day. It claims at most two Pages, processes Pages serially,
rechecks pressure before each 50-contact write batch, and leaves time to save
checkpoints. Unfinished batches retain their saved historical cursor and retry;
background backfill takes longer. Live webhook intake, the one-minute event
drain, receipt submission and interactive staff sync retain their current timing.

References: [Supabase database and disk size](https://supabase.com/docs/guides/platform/database-size),
[Metrics API](https://supabase.com/docs/guides/observability/metrics),
[Cron](https://supabase.com/docs/guides/cron).
