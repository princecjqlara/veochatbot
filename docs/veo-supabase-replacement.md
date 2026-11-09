# VEO replacement database preparation

Current direction supersedes the earlier upgrade plan: the owner requested a
fresh start on replacement `mjuluaqrvbnycisnarzi`, retaining the saved workforce,
chatbot setup and knowledge, with customer/contact history left empty. The
original project remains intact. No paid plan change is authorized.

Verified setup recovery restored 12 chatbot configurations, 479 knowledge
documents, 504 vector chunks, 476 Drive references, 12 pricing experiments and
48 packages. All selected setup values match their verified November 3 backup.
The saved November 7 directory restored seven account identities, their roles,
supervisor links, scoped Page grants and three teams. Fourteen backed-up Page
tokens were verified against Facebook. AIkita Studio has no backed-up connection
and remains pending; no Facebook identity or token was invented for it.

The database is about 39 MB with zero contacts, message history, old orders,
payments, archives or follow-up jobs. All seven restored scopes were checked.
Old password hashes and six staff emails are unavailable. The retained owner's
backed-up email receives a new random password saved only in the ignored local
owner sign-in file; other restored identities remain unable to sign in until
their email/password is configured by Owner in Accounts. This preserves IDs,
roles and Page grants, and cannot reactivate departed accounts.

Migration `202611090003` adds explicit, owner-only, 50-contact identity batches.
It imports names and Page-scoped identities without conversation messages,
historical stage events or source-processing jobs. Existing contact records are
untouched on retries. Owner starts each batch from the Sync view. Migration
`202611090004` provides scoped account-login recovery with private audit entries.

The owner supplied replacement project `mjuluaqrvbnycisnarzi` on 2026-11-09.
Read-only inspection found an empty application schema and a working PostgreSQL
17 database. Both supplied API keys work: a publishable key is intentionally
denied REST OpenAPI discovery, while normal SDK requests authenticate correctly.
Credentials remain in an ignored environment file, separate from production.

Initial preparation verified: the first 132 committed migrations installed,
115 public tables in a database of about 22 MB. The private photo bucket is
private, anonymous access to workspace finance/scope is denied, service-role
access works, all hierarchy definitions match the guarded source, and the
database maintenance job is inactive. All 14 targeted checks and TypeScript
validation passed. The setup-only recovery described above was subsequently
applied, together with the two recovery migrations. Production cutover is gated
on owner sign-in, build validation and live database/API checks.

The schema installer accepts only the original VEO project or this explicitly
approved replacement, and still checks every configured connection/key route.
Replacement receipts use a separate project directory. Run it from a clean
committed checkout so unrelated pending migrations are excluded:

```powershell
node --env-file=<replacement-env-file> scripts/provision-veobot-database.mjs --preflight --target-project=mjuluaqrvbnycisnarzi
node --env-file=<replacement-env-file> scripts/provision-veobot-database.mjs --apply --target-project=mjuluaqrvbnycisnarzi
```

The installer normalizes SQL line endings before executing function-body patch
migrations. Checksums still cover the original file bytes, preserving existing
migration receipt identities.

The replacement's database maintenance jobs are paused before the schema
transaction commits. Application recovery mode remains enabled until the import
and production checks are complete. Schema readiness is not data recovery.

The original project still refuses SQL connections. The verified November 3
local backup is a historical snapshot from the previous shared project, not a
complete export of the current VEO workspace. A partial historical import must
be labeled as incomplete and requires a data-recovery choice from the owner.
Preserve the original project, all contacts, tagging/assignments, best-contact
summaries, current controls and financial records. Do not cut production over
on the assumption that an older backup includes newer workspace records.

The owner explicitly requires the app's owner and staff accounts as part of the
transfer. The verified November 3 backup contains 36 legacy `users` records,
all without password hashes, and no `veo_*` workspace tables. It cannot restore
current VEO logins or staff access by itself. Account recovery needs current
`users` identities/credential hashes and activity flags, `veo_tenants`,
`veo_accounts` roles and supervisor links, Page permissions, teams and relevant
Telegram mappings. Preserve identity IDs and revoked/departed account status.
Do not infer roles from names, activate old legacy users, or claim the account
transfer complete based only on restoring a `users` table. Verify sign-in and
per-role access before production cutover. Recreating accounts or changing
passwords is a separate recovery decision, not an implicit part of an older
backup restore.

The source launch function also copied every profile snapshot into an immutable
archive. This is intentional duplicate storage, but its actual contribution to
the failed project's disk use remains unmeasured. Migration `202611090002`
prevents that additional profile copy at future launches. It does not remove
existing profiles or archives, and still archives the financial record tables.

At a verified cutover, set `VEO_DATABASE_PROJECT_REF=mjuluaqrvbnycisnarzi` together
with the replacement Supabase credentials. The runtime continues to default to
the original VEO project until explicitly configured, and always rejects the
former shared database. Verify data coverage, authentication, scopes, financial
invariants, private storage and queues before disabling recovery mode.
