# Workspace and receipt recovery: 19 November 2026

Signed-member checks reproduced an unavailable session, HTTP 503 receipt context,
and a receipt inbox timeout incorrectly returned as HTTP 400. Direct database
reads confirmed the affected member remained active, unsuspended and assigned
four Pages. The last retained resource sample showed high load, while fresh
monitoring timed out. Active database queries included continuation review claims
and PostgREST schema discovery. These observations establish intermittent service
failure below the receipt form; they do not prove a single infrastructure cause.

Sign-in and current workspace authorization now use a separate Supabase client
and availability circuit. A report or scheduled batch failure cannot open that
circuit. Authorization still reads the live database, rejects suspended users,
keeps no permission cache and fails closed on its own connection failure.

The scheduled chatbot route checks the existing resource guard before running
recovery, stage scans, continuation reviews or follow-ups. It uses a shared
`chatbot` job lease across serverless workers and reports recovery deferral as
HTTP 503 with retry guidance. Incoming webhooks retain their existing path.

Migration `202611190002` admits the new lease and checks resource availability
inside the continuation claim function before its original work. Healthy claims
use the existing shared background capacity lock. Function arguments, defaults,
owner and execution grants are preserved. Queues, eligibility rules, financial
records and staff permissions are retained. Scheduled work resumes when real
monitoring and maintenance permit it; unavailable monitoring is not called healthy.

Receipt read, upload and submit transport failures return HTTP 503. A lost save
response remains unconfirmed, retaining its stable request reference and preventing
the browser from treating a database timeout as a correctable input rejection.

Regression coverage verifies separate availability circuits, denial during a real
authorization outage, scheduler pressure/lease behavior, SQL deferral before queue
changes and retryable receipt failures. Production verification must check fresh
signed sessions, current client data and temporary evidence uploads with cleanup.
Existing receipt retries alone do not verify a new submission from the member.

Live inspection also found five business-state conflicts raised with SQLSTATE
`40001` across Telegram relinking, manual suspension and warning management.
The API connections identify themselves as PostgREST 14.18. Supabase documents
that [PostgREST 14 can retry this code indefinitely](https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b).
Migration `202611190003` changes only those explicit raises to `PT409`, retaining
the same stale-state rejection, owner, arguments, settings and private grants.
The HTTP routes recognize that conflict and retain compatibility with old codes.

Regression tests exercise all five actual conflict branches, verify no partial
suspension, warning, audit or Telegram identity writes, and keep the functions
service-only. A project-bound live preflight returned `PT409` for a stale lifting
selection and rolled back. The observed database rollback count does not show an
active retry storm; this fixes a verified risk without claiming it explains the
current outage.

Recovery checks must continue to distinguish pooled SQL connectivity from the
REST, Auth and Storage services. An idle PostgREST listener was refreshed without
terminating active transactions. Subsequent staff checks still failed, and no
provider-level restart has been performed. Do not report the workspace or Troy's
new receipt submission as recovered until the live HTTP checks pass.

After the user restarted Supabase, signed-member permissions, receipt context,
client search and all three temporary photo uploads recovered. A subsequent
sample showed a one-minute load of 5.16 while the five-minute average was 2.31
on two reported CPUs. The prior five-minute threshold (2.50) still admitted
optional work. Concurrent saved-tag repairs for three Pages were also visible.
These observations identify concrete admission gaps; query execution duration
alone is not a measurement of per-process CPU time.

Migration `202611190004` adds a one-minute load brake at one queued/running task
per reported CPU and preserves the three-minute recovery cooldown. Monitoring
records the exporter's sample time when supplied, so fetching an old cached
sample does not refresh its age. Older monitor payloads remain compatible during
deployment. Memory, swap, disk and five-minute load checks continue to apply.
Rollback preflight verified the new spike denial, stale-sample denial, cooldown,
private grants and fencing of the new job leases on the production project.

Auto-tag recovery claims one Page by default, processes Pages sequentially,
rechecks resource availability before each conversation and checkpoints a
pressure deferral without advancing its cursor. Its SQL tag repair also joins
the existing nonblocking shared background capacity lock and has a five-second
deadline. A shared scheduler lease prevents duplicate auto-tag invocations.

Both callers of the live-event drain now share one run lease. Between small
event batches, the drain rechecks resource state and reduces four independent
conversation lanes to one while optional work is paused. Incoming signed
webhooks still persist to the durable inbox. Event order, attempt fencing,
retry state, staff authorization and receipt storage checks are preserved.

These controls reduce preventable application pressure. They cannot guarantee
uninterrupted provider availability or make a small instance handle unlimited
traffic. Continue observing real load, memory, swap and service latency before
deciding whether additional compute is needed; no paid capacity change is made.

The later live audit found that normal SQL admission deferrals (`55P03`) were
opening the same availability circuit used to save scan checkpoints and release
run leases. Runtime logs showed release warnings, and Page attempts repeated
only after run-lease expiry while their prior checkpoints stayed unchanged.
The availability gate now recognizes JSON `55P03` responses at HTTP 500/503
as completed database deferrals. It retains the caller's error and performs
no retry, while permitting the caller's subsequent checkpoint and release.
Other database failures, query timeouts, rate limits, malformed error bodies
and gateway failures retain the existing outage circuit behavior.
