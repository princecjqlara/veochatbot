# VeoBot database and local backlog processing

VeoBot uses Supabase project `vhtbmdizugnxkgocmruq`. The application blocks its
former shared Tokko project. Do not run fetches, repairs or retries against that
project, or delete the shared project. Local and Vercel database routes must all
refer to the new destination. OpenRouter settings and chatbot configuration stay
the same.

The approved scope is the 15 Pages in `src/config/veo-pages.json`. Fourteen have
verified existing Facebook IDs. AIkita Studio is resolved by its Facebook-verified
name when connected; never invent a Page ID. Background message automation requires
a confirmed connection to the current app. Historical inbox access alone does not
confirm a live webhook connection.

The user authorized clearing old Page/customer data while retaining chatbot
features, knowledge and setup. All maintained schema migrations are installed.
The target-only reset backed up, restored and verified configurations, knowledge,
vectors, Drive sources, pricing definitions and approved Page memberships. Old
customer records, campaigns, pending jobs, outcomes and unrelated Pages were
cleared. Old deliveries are not replayed. The reset tool refuses another applied
reset, protecting subsequently collected data. Keep its private receipt.

`CONTACT_PROFILE_PROCESSING_MODE=local` prevents the profile worker from claiming
jobs, scanning Meta or calling OpenRouter. Live chatbot replies still use the
configured model. A refresh request waits for a local review covering that request.

Prepare and publish the saved backlog with new-database credentials:

```powershell
node scripts/prepare-veo-contact-identities.mjs
node scripts/analyze-retained-backlog.mjs --veo-only
node --env-file=.env.local scripts/publish-veo-local-backlog.mjs --preflight --limit=150
node --env-file=.env.local scripts/publish-veo-local-backlog.mjs --apply
node --env-file=.env.local scripts/publish-veo-local-projections.mjs --preflight
node --env-file=.env.local scripts/publish-veo-local-projections.mjs --apply
```

These tools use saved archives, never connect to the old database, and never send
customer messages. Analysis verifies archive fingerprints and source citations.
Supabase stores completed profiles and cited source messages. Full raw histories
remain locally archived. The UI labels supporting messages separately from the
full analyzed history. Literal answers, questions, stage notices and chat payment
statements remain source-cited. Chat statements cannot create verified payments.

Publication commits contacts, evidence, snapshots, ready jobs and audit receipts
in batches. It preserves existing controls and newer activity or review requests.
Only parser-verified Page stage notices update stages and add history tags. A
transaction-local flag prevents historical notices from queueing remote AI work.
Conversations without customer messages do not create inquiries. Re-running after
a timeout resumes the last committed checkpoint. The journal also prevents
duplicates after a crash between database commit and checkpoint writing.
The projections pass rebuilds complete-history features and inquiry/payment
evidence for the calendar from the same reviewed archives. It uses the existing
deterministic forecasting engine, preserves newer sources, labels its source as
audited history, and does not backdate forecast issues or create verified receipts.
Run it again if profile publication was still in progress during the previous pass.

Keep credentials, raw archives, fingerprints and receipts private under `.vercel`.
Saved-history counts are not current Meta totals. Refresh missing/new histories
only for approved Pages, then analyze and publish the updated registry locally.
`scripts/refresh-veo-missing-profiles.mjs --audit=<private-audit.json>` refreshes
up to 100 audited missing profiles from the destination's Page credentials. It
saves complete raw histories locally, verifies citations, publishes atomically
and refreshes deterministic forecast features without any model calls. The audit
must name `target_project` and contain `missing_profiles` with verified Page,
Facebook Page and PSID identities. Retain its refreshed manifests separately from
the sealed historical pass.

`scripts/verify-veo-page-connections.mjs` checks identities, inbox access and app
subscriptions without customer messages. Pages requiring reconnection need
Facebook authorization through Refresh Permissions and Connect; retain their setup.

`scripts/cutover-veobot-environment.mjs` updates production, preview and development
database settings, removes stale pooler aliases and preserves unrelated settings.
Deploy afterward. Verify the live alias commit, deployed Supabase URL,
authenticated Page/contact reads, source links, calendar APIs and the local-mode
profile scheduler. A local build does not prove production cutover.
