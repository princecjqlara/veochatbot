# VeoBot database separation

The authorized destination is `vhtbmdizugnxkgocmruq`. The deployed app and the
Tokko Dev checkout currently inherit `pnhzpeyzpwsmwcuafgpw`. Production must
remain on its current configuration until the scoped data copy is verified.
Do not change Tokko Dev's environment or write migration repairs to the source.

The destination currently has an empty lightweight `pages`/`messages` schema.
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
are implemented and pass. Incomplete or mismatched receipts never count as a
completed stage. No model requests or customer messages are made by these retries.
