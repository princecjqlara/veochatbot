# Contact history cleanup scope

Keep all existing tags and contact-tag assignments. The user's clarification
on 2026-11-09 retains tagging as an important feature. Tag name matches are audit
candidates only; they do not authorize merging or deleting tags.

Also retain contact identities and Page/PSID links, names, contact details,
best-contact hours/confidence and their compact hourly counters, current stages,
opt-outs and manual pauses, latest useful profiles and extracted answers, active
automation state, pending events, orders, receipts, payments and commissions.

The saved `.vercel/veo-backlog/local-conversation-cleanup.json` receipt reports a
completed earlier cleanup: 554,206 raw message rows became zero and the raw
transcript table was removed. It retained 49,745 contacts, 100,135 versioned
profile snapshots and 9,656 tag assignments. These are historical receipt
counts, not a current live inventory. Multiple snapshots can be legitimate
versions; they are not proof of duplicate contact records or disk exhaustion.

The source schema prevents duplicate `(page_id, psid)` contacts, duplicate
`(contact_id, tag_id)` assignments and duplicate inbox event keys. Live index
validity still needs checking after PostgreSQL is reachable. The same person
on two Pages is not a duplicate because Messenger identity is scoped to a Page.

`contact_interactions` can be a compatibility view which expands compact hourly
counters into logical events. Its returned row count is not a physical row or
disk size measurement. Preserve its hourly summary table for best-contact times.

Run bounded read-only metadata diagnostics first:

```powershell
node --env-file=.env.local scripts/audit-contact-storage.mjs --inspect
```

After disk headroom is restored, optional scans count older profile versions and
sample matching profile payloads and same-name tags:

```powershell
node --env-file=.env.local scripts/audit-contact-storage.mjs --inspect --scan-samples
```

The audit reports relation sizes including indexes/TOAST, WAL bytes when allowed,
and unique index definitions. Query deadlines are 2.5 seconds. Scans disable
temporary disk spills or are skipped if that protection cannot be set. Sample
results are not a complete duplicate inventory. No contact identifiers, names or
profile payloads are printed. No deletes or writes to application tables occur.

Review obsolete profile generations, expired completed delivery history and old
processed event payloads after obtaining actual sizes and validating references
and local backups. Keep latest and actively referenced evidence. Do not remove
stage/payment history required by reports or receipt validation. Bulk deletion
must not run against a database that is still offline or critically low on disk.
No destructive cleanup has been performed as part of this audit.
