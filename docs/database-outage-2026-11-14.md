# Database outage, 14 November 2026

## Evidence and limits

The app lost direct PostgreSQL and REST access. Supabase's detailed service checks showed database, auth, REST and storage failures while the broad project status initially said healthy. Scheduled database maintenance reported `job startup timeout`; PostgreSQL logs recorded statement timeouts across application and platform services. A project restart restored connections without resetting or deleting the database.

After recovery, the database was approximately 234 MB with about 1.50 GB free on the data disk, no blocked queries, and fewer than 60 configured connections. Host metrics reported about 434 MiB RAM, roughly 87 MiB available, about half of 1 GiB swap occupied, and a five-minute load of 1.89. These are post-restart measurements, not proof of the exact resource levels at the start of the outage. An out-of-memory kill or provider infrastructure fault has not been established.

Confirmed application pressure sources: eleven scheduled routes started on overlapping minute boundaries; contact pagination materialized all contact display fields before sorting, with temporary disk writes in query statistics. The server had 46,000+ contacts. The ten-second application timeout did not provide a short database-side limit for several background RPCs. Historical inquiry recovery also lacked the optional-work health check used by identity imports.

## Changes

- Contact pagination counts and sorts only IDs and activity dates, then loads display fields for the requested page. Scope, literal search, ordering, totals and response fields remain the same.
- Monitoring records available memory, swap and five-minute load every minute, alongside existing disk checks. Missing resource measurements pause optional work.
- Optional work pauses below 10% available memory (or 32 MiB), above 70% swap usage, or above 1.25 five-minute load per CPU. Three minutes of cooldown prevent immediate restart of bulk work after pressure clears. Monitoring automatically clears the pause after fresh healthy measurements and cooldown.
- Historical inquiry recovery checks this gate before leasing work. Existing identity and profile imports use the same gate. Live inbound ingestion and scheduled event processing remain enabled.
- Historical inquiry and profile schedules are staggered, as are five-minute quota and ad-spend jobs. Essential live processing stays every minute.
- Selected background RPCs and contacts pagination have database-side statement timeouts shorter than the application's ten-second request deadline. PostgREST schema reload applies the hoisted settings.
- Collection health shows resource pressure and stale measurements rather than declaring a healthy database from disk space alone.

## Recovery checks

Check detailed Supabase service health, a real authenticated app request, `/api/cron/database-health` with scheduler authentication, database maintenance run results, and whether the live-event queue is draining. A session endpoint or project summary alone is insufficient. Jaucian's health remains unhealthy for failed or overdue deliveries; do not hide failures to make a dashboard green. Inspect delivery acknowledgments and eligibility before retrying any failed outbox item. Never invoke the dispatcher manually for testing.

If the service becomes completely unreachable again, preserve logs and resource observations before a controlled restart. Do not reset or delete the database. Increasing paid compute or adding failover requires a separate infrastructure decision; these safeguards cannot guarantee provider availability.
