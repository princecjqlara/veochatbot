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
