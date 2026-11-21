# Database timeout prevention

Salary, performance and calendar finance read recorded quota snapshots. Report
filters never trigger the all-staff quota calculation. The calendar also reads
its existing planning snapshots. Today's figures remain provisional; missing
salary snapshots produce a retryable error rather than an invented total.

The existing quota schedule claims at most four worker leases at once and
commits each worker separately. Each SQL update has a five-second deadline and
the run starts work for at most ninety seconds, rechecking resource pressure
between batches. A 150-second shared run lease prevents
overlapping scheduler invocations. Failed or abandoned work remains retryable;
a timed-out worker rolls back and receives a ten-minute cooldown. Completed
worker updates are retained. Team planning uses recorded operating quotas.

Salary reconciliation processes at most ten queued days per invocation and
does not replan today's quotas. The existing queue ordering and correction
triggers remain intact. Optional maintenance failures defer heavier phases;
eligibility, receipt expiry and due delivery checks continue independently.

Concurrent permission reads for the same identity share only their in-flight
request. Completed results are discarded so the next request rechecks access.
SQL, pool and transport timeouts are not automatically repeated. A transient
gateway error may retry once. The recovery circuit observes failures after
response headers as well as failures while connecting, and allows one recovery
probe during a cooldown. Writes are never automatically replayed.
Basic Accounts, Pages and contact-list reads have their own recovery circuit,
separate from heavy reports/background work and from live permission checks.
An unrelated background timeout cannot open that circuit; a genuine interactive
database outage still fails closed and receives its own cooldown.

`scripts/repair-data-api-schema-cache.mjs --preflight` checks the API role
settings without committing changes. `--apply` allows metadata startup up to
sixty seconds, preserves ordinary service-query deadlines, and limits abandoned
API transactions to thirty seconds. Use `--reconnect` only for an existing API
pool that needs its login-time settings refreshed; it is not a scheduled action.
No automatic database restart is added.

Maintenance cadence is persisted across server instances by migration
`202611210001`. Previous-day salary reconciliation runs at most every two minutes;
planning and completed-event upkeep run at most every five minutes. Their
existing calculations, correction queue and transaction admission lock are
unchanged. A failed phase retries after one to five minutes, and an abandoned
30-second lease cannot be completed by a newer or expired owner. Live inbound
ingestion, editor offers, receipt delivery and independent photo expiry retain
their own schedules.

The database-health endpoint checks both maintenance phases separately from
host and storage metrics. Missing, repeatedly failing or stale successes remain
unhealthy; monitoring does not run a worker or restart the database. Optional
work rechecks resource pressure after maintenance before starting enrichment.
Discipline and expired intake-menu cleanup also have five-second SQL deadlines
and one-second lock deadlines.

Install this migration before deploying the updated routes. Run
`node scripts/release-maintenance-cadence.mjs preflight`, then `apply` and `verify`.
Preflight exercises recovery inside a rolled-back transaction; verification
checks cross-connection contention without executing maintenance or delivery.

Monitor Collection health and the existing database-health schedule. Memory,
swap, disk and stale monitoring pause optional bulk work. A healthy reading is
not a guarantee against provider outages or future capacity exhaustion. Keep
backups and review compute/storage capacity as essential data and traffic grow.

References: [PostgreSQL idle transaction timeout](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT),
[PostgREST transaction settings](https://docs.postgrest.org/en/v13/references/transactions.html#transaction-scoped-settings).
