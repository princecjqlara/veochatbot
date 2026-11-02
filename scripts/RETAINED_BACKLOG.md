The retained backlog tools prepare and publish contact profiles without model
requests or customer messages. They do not change the chatbot reply flow.

1. `node scripts/audit-retained-system-data.mjs` inventories recognized local
   source exports and writes the source registry under `.vercel/system-data-audit`.
2. `node scripts/analyze-retained-backlog.mjs` extracts literal customer answers,
   question wording, Page stage notices and chat payment evidence. It uses the
   registry's last-known connected Page scope. It verifies source fingerprints
   and citations, then saves compressed profiles and an atomic manifest under
   `.vercel/backlog-analysis`. `--limit=100` prepares a sample only. Run one
   analysis process at a time; valid saved profiles are reused after a restart.
3. With database credentials loaded, `node scripts/publish-prepared-backlog.mjs
   --preflight --limit=25` tests publication with transaction rollback.
   `--apply --limit=250` commits a bounded pass and saves a resume position.
   Publication rechecks actual Page access and joins contacts by Page and PSID,
   never by IDs copied from old exports. Only profile snapshots, their source
   messages, ready job checkpoints and a private publication journal are written.
4. `node scripts/run-prepared-backlog-publication.mjs` waits for analysis and
   database availability, then runs preflight and bounded publication passes.
   It saves its status and logs locally, retries without OpenRouter calls, and
   revisits missing contacts while the separate connected-inbox fetch runs.

Check `status.json`, `publication-background-status.json`, `publish-apply.json`
and the prepared manifest in `.vercel/backlog-analysis`. A saved profile is not
proof that it was published. Errors retain the original histories and artifacts.
The scripts do not establish current live contact totals from archived exports.

Explicit answers and source events are extracted; images and ambiguous language
remain for review. Chat payment statements are separate from verified receipts,
purchase counts and revenue. Existing model reviews, active/newer requests and
newer contact activity prevent replacement by an older prepared profile. Future
stage changes can still request normal live analysis. Raw data, profiles,
credentials and progress files stay in ignored workspace directories.
