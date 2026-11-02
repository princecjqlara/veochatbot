# Facebook Page connections

Connect first reads the saved Page identity. A storage read error never becomes
an instruction to create another Page. The submitted credential must identify
the selected Facebook Page and read its inbox before a stored token is replaced.
Empty accessible inboxes are valid. Names are taken from the verified Page.
New Page saves use the unique Facebook Page ID so retries cannot create
duplicate identities. Page membership must return the saved Page ID.

The action is complete only after Facebook confirms the app's subscription to
message, postback, echo and referral events. A failed subscription retains saved
Page access but returns setup-incomplete status and a Reconnect action. Missing
permissions request Facebook reauthorization; temporary failures stay retryable.
The Connect screen rechecks app subscription status when loading saved Pages.
Unavailable checks are unknown, and do not erase saved Page connections.

Connect, Page listing, database operations and initial contact-sync slices have
bounded requests. A Page's initial sync runs separately from connection setup;
its progress does not lock Connect actions for other Pages. Older status reads
cannot overwrite a successful connection result. Page listing follows complete,
deduplicated Graph pagination and rejects failed or repeated continuations
instead of publishing a partial list.

These fixes do not restore an unavailable database. The existing `.env.local`
service-role key and database URLs are sufficient for ordinary imports. For
project health/log access without the Supabase integration, a project-scoped
personal access token can be stored locally as `SUPABASE_ACCESS_TOKEN`. Tokens
and passwords must remain in ignored environment files, never in commits.
