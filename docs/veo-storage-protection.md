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

A Vercel cron separately checks Supabase's authenticated Metrics API every five
minutes. It reads `/data` available bytes (including filesystem reservations),
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

References: [Supabase database and disk size](https://supabase.com/docs/guides/platform/database-size),
[Metrics API](https://supabase.com/docs/guides/observability/metrics),
[Cron](https://supabase.com/docs/guides/cron).
