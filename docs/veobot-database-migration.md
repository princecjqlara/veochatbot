# VeoBot database separation

The authorized destination is `vhtbmdizugnxkgocmruq`. The deployed app and the
Tokko Dev checkout currently inherit `pnhzpeyzpwsmwcuafgpw`. Production must
remain on its current configuration until the scoped data copy is verified.
Do not change Tokko Dev's environment or write migration repairs to the source.

The destination originally had an empty lightweight `pages`/`messages` schema.
It cannot run the CRM simply by replacing an API URL. The schema installer moves
these empty tables into the private `veobot_legacy` schema, preserving them,
then installs all maintained migrations. It refuses an unrecognized or nonempty
legacy schema. Every migration is fingerprinted, with a destination advisory
lock and one transaction covering installation or preflight rollback.

Generate the review plan without credentials:

```powershell
node scripts/provision-veobot-database.mjs --plan --target-project=vhtbmdizugnxkgocmruq
```

When the destination's actual Session pooler URL is available, put it with the
destination URL, anon key, service-role key and direct URL in an ignored local
environment file. All routes and JWT project claims must match the destination.
Prefer the host from the project's Connect panel. A route independently verified
by successful project-specific authentication and read-only schema checks can
also be used. Never assume a pooler cluster index from its AWS region alone.

```powershell
node --env-file=.vercel/veobot-intended-project.env.local scripts/provision-veobot-database.mjs --preflight --target-project=vhtbmdizugnxkgocmruq
node --env-file=.vercel/veobot-intended-project.env.local scripts/provision-veobot-database.mjs --apply --target-project=vhtbmdizugnxkgocmruq
```

The plan and receipts are saved in `.vercel/database-migration`. A passing local
test or plan is not evidence that the remote schema was installed. Production's
actual extension support, permissions and schema still require live preflight.

Before cutover:

1. Read the source through a consistent snapshot and export the approved VeoBot
   Page set and its required users, memberships and dependent records. Keep
   unrelated Tokko Dev records out of the destination. Preserve complete IDs,
   timestamps, attribution, tags, bot settings, manual decisions and verified
   financial records. Stop on ambiguous ownership or missing dependencies.
2. Save the export with table counts and checksums before importing. The retained
   conversation exports and 62,866 prepared profiles are not a complete source
   database backup and cannot supply missing payment amounts or manual tags.
3. Import and verify row identities, foreign keys, counts, tags, financial sums,
   Page membership and bot settings. Check that importing historical stages does
   not enqueue a bulk AI backlog or deliver customer messages. Do not replay
   pending campaigns or follow-ups during migration.
   Existing application traffic may continue changing the source after the
   snapshot. Capture and verify those later changes before cutover; a snapshot
   copy alone is not proof that the destination is current. Coordinate the final
   Page-write transition without disabling unrelated Tokko Dev operations.
4. Verify calendar cohorts against inquiry counts and recorded outcomes, spend,
   receipts and currencies on the destination. Missing data remains unavailable.
5. Save the existing production environment as rollback evidence. Change all
   Supabase and PostgreSQL routes consistently, deploy once, and verify the live
   alias and authenticated data reads. Clear inherited pooler routes rather than
   leaving any source connection in the destination configuration.
6. Restart fetching/profile publication only with the verified destination and
   appropriate Page identity mapping. Keep source repair workers stopped.

Current access limitations and migration authorization are recorded privately in
`.vercel/database-migration/progress.json`. Do not mark migration complete while
source backup, destination installation, import verification or cutover is pending.

## Automatic prerequisite retries

`node scripts/run-veobot-migration-retries.mjs` watches the two ignored environment
files, checks both PostgreSQL endpoints using read-only transactions, and backs
off timeout attempts from 30 seconds to five minutes. Circuit-breaker errors
receive at least 150 seconds. It detects updated pooler settings without a restart
and distinguishes IPv6 routing failures from temporary query timeouts. Direct
database DNS is resolved explicitly so an IPv6-only host is not reported as absent.
The singleton lock verifies process identity and creation time on Windows.
After repeated source timeouts, the connection wait increases to 30 seconds so
a busy session pooler has more time to assign a connection. Query reads remain
bounded and read-only; invalid credentials and missing routes stay explicit.

Once destination access works, the worker retries transactional schema preflight
and installation with fresh run IDs and matching migration fingerprints. When
source access works, it checks account membership, inbox access and subscription
to VeoBot's Facebook app before saving a read-only schema and ownership inventory.
Different Meta apps must not be treated as proof of shared Page ownership.
On restart, a committed schema checkpoint is reused only after a fresh read-only
check confirms every migration fingerprint in the destination database.

The worker saves `retry-status.json`, per-stage receipts and a log in the migration
directory. Its automated scope is connection recovery, destination provisioning
and source ownership/schema inspection. It does not substitute an inventory for
a backup, import customer rows, or switch the production database. Those remain
pending until the consistent scoped export, import and financial/calendar checks
pass. The separate backup and import commands below perform the data stages;
the prerequisite worker does not run them or approve a cutover. Incomplete or mismatched receipts never count as a
completed stage. No model requests or customer messages are made by these retries.

## Preserve the complete chatbot setup

`backup-veobot-account.mjs` saves a consistent, read-only snapshot of the Pages
currently linked to the verified account and their application data. This is a
preservation backup, separate from approval of the import/activation scope.
Disconnected Pages retain their settings; a failed Facebook token check does not
mean their old configuration should be discarded. The original migration scope
must still be reconciled before importing additional Pages.

The backup includes every column of every `chatbot_` table, shared knowledge,
vectors, pricing controls, media references, Drive records, collection state,
handoffs, automation epochs and delivery/job history. It also includes contacts,
tags, campaign audiences, permissions, welcome messages, workflows, attribution
and verified finances. Required users and original record IDs are preserved.
Tokko-specific account/authentication tables are explicitly excluded. Unrecognized
global tables stop the backup for review; new Page-scoped chatbot tables are
included automatically. Extra columns are retained in the original artifacts
even when the destination schema does not yet support them.

```powershell
node --env-file=.vercel/database-migration/source-production.env.local scripts/backup-veobot-account.mjs
node --env-file=.vercel/database-migration/source-production.env.local scripts/backup-veobot-storage.mjs
node scripts/verify-veobot-backup.mjs
node --env-file=.vercel/veobot-intended-project.env.local scripts/compare-veobot-chatbot-setup.mjs
```

Artifacts stay under the ignored `.vercel/database-migration/backups` directory.
Rows stream from one PostgreSQL repeatable-read snapshot into compressed JSONL
with counts and SHA256 checksums. Original PostgreSQL JSON text is hashed without
converting large numbers through JavaScript. Failed snapshots are never combined
with a later retry. Foreign keys, polymorphic tag ownership, shared knowledge and
campaign audience references are checked for missing or out-of-scope parents.

The verifier requires every source table and original column in the manifest,
then checks every decompressed byte and row count. The destination comparison
requires matching original chatbot column types and matching counts/checksums
for all chatbot setup and state tables. Empty destination tables fail whenever
the source has records. A passing backup is not proof of a finished migration;
storage object bytes, any unsupported source extensions, import scope, final
changes, the financial/calendar checks and production cutover remain separate
requirements. Do not change prompts, models, enabled flags or queued jobs just
to make a comparison pass.

Use `backup-veobot-account.mjs --chatbot-only` for an additional, quicker chatbot
checkpoint while a large account export runs. It writes a separate status and
latest-checkpoint file. Its verifier checks all chatbot setup/state tables, but
it cannot be marked as a complete account backup or used to bypass the full data
copy. The destination comparison can take `--manifest=...` explicitly.

The long CRM snapshot does not read Storage tables: holding a read lock on them
can delay Supabase's own Storage schema upgrades. The separate storage command
inventories only files associated with the account's selected Pages or export
jobs. It preserves their original bytes, checks sizes, source update timestamps
and local SHA256 hashes, and reuses previously verified downloads on retries.
An unavailable file remains a failed checkpoint. Database snapshots are never
combined across retries; a final source change check is still needed at cutover.

## Verified imports and retry checkpoints

`account-import-scope.json` records the current account Page set separately from
which Pages have a verified connection to the VeoBot Facebook app. All preserved
settings are copied; another app's automation must not start just because its
historical data was preserved. Migration `202611030001` adds a separate Page
automation owner and an optional private runtime policy. It filters atomic
recovery/review claims, and the application filters follow-up, workflow and
campaign queues before their limits. The policy has no effect on the original
database. Production enables `VEO_ENFORCE_PAGE_RUNTIME_SCOPE=true` only after the
destination's owned Page set and policy are configured. A successful reconnect
must confirm the current Facebook app subscription before registering ownership.

```powershell
node --env-file=.vercel/veobot-intended-project.env.local scripts/import-veobot-account.mjs --plan --target-project=vhtbmdizugnxkgocmruq
node --env-file=.vercel/veobot-intended-project.env.local scripts/apply-veobot-import-checkpoints.mjs --target-project=vhtbmdizugnxkgocmruq
node --env-file=.vercel/veobot-intended-project.env.local scripts/restore-veobot-storage.mjs
```

The checkpointed importer requires the exact verified snapshot and account scope.
It refuses destination records without matching import checkpoints. It preserves
19 legacy Page/account columns instead of dropping their values, and refuses
unknown nonempty tables. The empty legacy Telegram standby table is accounted
for explicitly. Each table is copied, checked against a source-derived SHA256
fingerprint of every original row, and committed together with its checkpoint.
On retry, committed tables are rechecked before reuse. An incomplete table rolls
back. Source writes, customer sends and model calls are not part of import.

Historical inserts temporarily disable only application triggers on that table;
foreign keys and checks still run. Original trigger modes are restored before
commit. Generated IDs are imported explicitly and their sequences advance past
the imported maximum. Exact existing placeholder contact names are recorded in a
private exception table, so they retain their values and allow stage updates;
new invalid names remain rejected. Target retention jobs pause through their
supported cron API while staging and must be reviewed before resuming production.

Bulk transfer uses native COPY into a bounded temporary JSON staging table, then
typed inserts with original IDs, nulls, vectors and timestamps. CSV control
characters cannot occur literally in canonical PostgreSQL JSON; the importer
checks this before transfer. Numeric values are never parsed through JavaScript.
Storage restores use conditional uploads and verify downloaded bytes afterward.
Unrecognized existing object contents are never overwritten.

If disk fills, use `--defer-large-history` to finish and verify the core/customer
and chatbot tables while retaining the complete history backup. This explicitly
leaves `baseline_complete=false`; it is not a completed migration. The two
deferred tables are `campaign_recipients` and `outbound_message_events`. Resume
without that option after capacity is sufficient. Do not discard original
history, remove required indexes, or switch production to an incomplete copy.
