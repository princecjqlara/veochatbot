// Publish complete, source-verified conversation text in compressed form.
// Raw media files and expiring attachment URLs are deliberately not copied.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import pg from 'pg';
import { assertProjectCredentials, VEO_TARGET_PROJECT, digest } from './lib/database-migration-safety.mjs';

const apply = process.argv.includes('--apply');
if (!apply && !process.argv.includes('--preflight')) throw Error('Choose --preflight or --apply');
const { parse } = createRequire(import.meta.url)('dotenv');
const env = parse(fs.readFileSync('.env.local', 'utf8'));
const endpoint = assertProjectCredentials(env, VEO_TARGET_PROJECT);
const dir = path.resolve('.vercel/veo-backlog');
const manifestText = fs.readFileSync(path.join(dir, 'prepared-manifest.jsonl'), 'utf8');
const baseRows = manifestText.split('\n').filter(Boolean).map(JSON.parse);
const allowed = new Set(JSON.parse(fs.readFileSync('src/config/veo-pages.json', 'utf8')).map(page => page.facebook_page_id));
const bundle = path.join(dir, 'analysis-runtime.cjs');
const { verifyBacklogArtifact } = createRequire(import.meta.url)(bundle);
const latestByIdentity = new Map(baseRows.map(row => [`${row.page_id}:${row.psid}`, row]));
const refreshedDir = path.join(dir, 'refreshed');
for (const name of fs.readdirSync(refreshedDir).filter(value => value.endsWith('.profile.json.gz'))) {
  const file = path.join(refreshedDir, name), compressed = fs.readFileSync(file), artifact = JSON.parse(gunzipSync(compressed).toString('utf8'));
  if (!allowed.has(artifact.facebook_page_id)) continue;
  const key = `${artifact.page_id}:${artifact.psid}`, previous = latestByIdentity.get(key);
  if (!previous || Date.parse(artifact.source_cutoff_at) > Date.parse(previous.source_cutoff_at)) latestByIdentity.set(key, {
    page_id: artifact.page_id, psid: artifact.psid, facebook_page_id: artifact.facebook_page_id,
    source_sha256: artifact.source_sha256, source_cutoff_at: artifact.source_cutoff_at,
    artifact: path.relative(process.cwd(), file), artifact_sha256: digest(compressed), verified: true
  });
}
const rows = [...latestByIdentity.values()];
const approvedRows = rows.filter(row => allowed.has(row.facebook_page_id));
assert.equal(approvedRows.length, rows.length, 'Manifest contains a non-approved Page');
const batchSize = Number(process.argv.find(value => value.startsWith('--batch-size='))?.slice(13) || 100);
assert(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 100, 'Batch size must be 1..100');
const report = { target_project: VEO_TARGET_PROJECT, approved_pages: allowed.size, sources: rows.length, refreshed_sources: rows.length - baseRows.length, matched_contacts: 0,
  archived_messages: 0, attachment_references: 0, image_references: 0, skipped_unknown_contacts: 0,
  skipped_newer_archives: 0, applied: apply, status: 'starting' };
const db = new pg.Client({ connectionString: endpoint.connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 25000, query_timeout: 120000 });
const migrations = [
  ['202611050001', 'order_created_paid_conversion'],
  ['202611050002', 'contact_conversation_archives'],
  ['202611050003', 'calendar_cohort_conversation_metrics']
].map(([version, name]) => ({ version, name, sql: fs.readFileSync(`supabase/migrations/${version}_${name}.sql`, 'utf8') }));
const checkpointPath = path.join(dir, 'conversation-archive-publication.json');
try {
  await db.connect();
  if (apply) {
    const tracked = new Set((await db.query("SELECT version FROM app_private.schema_migrations WHERE version=ANY($1::text[])", [migrations.map(migration => migration.version)])).rows.map(row => row.version));
    const orderRule = (await db.query("SELECT to_regprocedure('public.ad_calendar_outcomes_core(uuid[],timestamptz,timestamptz,text,boolean)') IS NOT NULL AND pg_get_functiondef(to_regprocedure('public.ad_calendar_outcomes_core(uuid[],timestamptz,timestamptz,text,boolean)')) LIKE '%s.stage IN (''converted'',''order_created'')%' AS applied")).rows[0].applied;
    for (const migration of migrations) {
      if (tracked.has(migration.version) || migration.version === '202611050001' && orderRule) continue;
      await db.query(migration.sql);
    }
  }
  const contacts = (await db.query(`SELECT c.id,c.page_id,c.psid,p.fb_page_id
    FROM public.contacts c JOIN public.pages p ON p.id=c.page_id WHERE p.fb_page_id=ANY($1::text[])`, [[...allowed]])).rows;
  const byIdentity = new Map(contacts.map(contact => [`${contact.page_id}:${contact.psid}`, contact]));
  const snapshots = (await db.query(`SELECT DISTINCT ON(contact_id) contact_id,page_id,generation,source_cutoff_at
    FROM public.contact_profile_snapshots WHERE page_id IN (SELECT id FROM public.pages WHERE fb_page_id=ANY($1::text[]))
    ORDER BY contact_id,generation DESC`, [[...allowed]])).rows;
  const byContact = new Map(snapshots.map(snapshot => [snapshot.contact_id, snapshot]));
  const priorArchives = apply ? (await db.query(`SELECT contact_id,snapshot_generation,source_cutoff_at,source_sha256
    FROM public.contact_profile_transcripts WHERE page_id IN (SELECT id FROM public.pages WHERE fb_page_id=ANY($1::text[]))`, [[...allowed]])).rows : [];
  const byArchive = new Map(priorArchives.map(archive => [archive.contact_id, archive]));
  report.existing_archives_skipped = 0;
  report.matched_contacts = approvedRows.filter(row => { const contact = byIdentity.get(`${row.page_id}:${row.psid}`); return contact && byContact.has(contact.id); }).length;
  report.skipped_unknown_contacts = approvedRows.length - report.matched_contacts;
  let offset = 0, batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const input = batch; batch = [];
    await db.query('BEGIN');
    try {
      await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'");
      await db.query(`INSERT INTO public.contact_profile_transcripts(contact_id,page_id,snapshot_generation,source_cutoff_at,source_sha256,message_count,customer_message_count,page_message_count,customer_messages_replied,attachment_count,image_count,messages_gzip_base64)
        SELECT r.contact_id,r.page_id,r.snapshot_generation,r.source_cutoff_at,r.source_sha256,r.message_count,r.customer_message_count,r.page_message_count,r.customer_messages_replied,r.attachment_count,r.image_count,r.messages_gzip_base64
        FROM jsonb_to_recordset($1::jsonb) AS r(contact_id uuid,page_id uuid,snapshot_generation integer,source_cutoff_at timestamptz,source_sha256 text,message_count integer,customer_message_count integer,page_message_count integer,customer_messages_replied integer,attachment_count bigint,image_count bigint,messages_gzip_base64 text)
        ON CONFLICT(contact_id) DO UPDATE SET page_id=EXCLUDED.page_id,snapshot_generation=EXCLUDED.snapshot_generation,source_cutoff_at=EXCLUDED.source_cutoff_at,
          source_sha256=EXCLUDED.source_sha256,message_count=EXCLUDED.message_count,customer_message_count=EXCLUDED.customer_message_count,
          page_message_count=EXCLUDED.page_message_count,customer_messages_replied=EXCLUDED.customer_messages_replied,attachment_count=EXCLUDED.attachment_count,
          image_count=EXCLUDED.image_count,messages_gzip_base64=EXCLUDED.messages_gzip_base64,updated_at=clock_timestamp()
        WHERE EXCLUDED.source_cutoff_at>=contact_profile_transcripts.source_cutoff_at`, [JSON.stringify(input)]);
      await db.query(`UPDATE public.contact_profile_snapshots s SET payload=payload||jsonb_build_object(
        'database_message_storage','complete_archive','complete_archive_source_sha256',r.source_sha256,'complete_archive_cutoff_at',r.source_cutoff_at)
        FROM jsonb_to_recordset($1::jsonb) AS r(contact_id uuid,page_id uuid,snapshot_generation integer,source_cutoff_at timestamptz,source_sha256 text)
        WHERE s.contact_id=r.contact_id AND s.page_id=r.page_id AND s.generation=r.snapshot_generation
          AND s.source_cutoff_at<=r.source_cutoff_at`, [JSON.stringify(input)]);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  };
  for (const row of approvedRows) {
    const contact = byIdentity.get(`${row.page_id}:${row.psid}`);
    if (!contact) { offset++; continue; }
    if (contact.fb_page_id !== row.facebook_page_id || !allowed.has(contact.fb_page_id)) throw Error('Database contact Page differs from approved archive identity');
    const snapshot = byContact.get(contact.id);
    if (!snapshot || snapshot.page_id !== contact.page_id) { report.skipped_unknown_contacts++; offset++; continue; }
    if (Date.parse(row.source_cutoff_at) < Date.parse(snapshot.source_cutoff_at)) { report.skipped_newer_archives++; offset++; continue; }
    const prior = byArchive.get(contact.id);
    if (apply && prior?.snapshot_generation === snapshot.generation && prior.source_sha256 === row.source_sha256) {
      report.existing_archives_skipped++; offset++; continue;
    }
    const artifactPath = path.resolve(row.artifact);
    if (!artifactPath.startsWith(dir + path.sep)) throw Error('Prepared transcript path escaped the Veo backlog');
    const compressed = fs.readFileSync(artifactPath);
    if (digest(compressed) !== row.artifact_sha256) throw Error('Prepared transcript fingerprint changed');
    const artifact = JSON.parse(gunzipSync(compressed).toString('utf8'));
    verifyBacklogArtifact(artifact);
    if (artifact.page_id !== row.page_id || artifact.facebook_page_id !== row.facebook_page_id || artifact.psid !== row.psid || artifact.source_sha256 !== row.source_sha256) throw Error('Transcript identity or source fingerprint mismatch');
    const repo = path.resolve('.'), workspace = path.resolve('..');
    const approvedArchiveRoots = [path.join(repo, '.vercel'), path.join(workspace, '.vercel'),
      path.join(repo, 'data'), path.join(workspace, 'data'), path.join(workspace, 'tokkodev')];
    const sourceFile = [path.resolve(repo, artifact.source_archive), path.resolve(workspace, artifact.source_archive)]
      .find(candidate => approvedArchiveRoots.some(root => candidate.startsWith(root + path.sep)) && fs.existsSync(candidate));
    if (!sourceFile) throw Error(`Raw conversation path is absent from approved local archives (${artifact.source_sha256})`);
    const sourceBytes = fs.readFileSync(sourceFile), sourceText = (sourceFile.endsWith('.gz') ? gunzipSync(sourceBytes).toString('utf8') : sourceBytes.toString('utf8')).replace(/^\uFEFF/, '');
    if (digest(sourceText) !== artifact.source_sha256) throw Error('Raw conversation fingerprint does not match the prepared analysis');
    const cutoff = Date.parse(artifact.source_cutoff_at);
    if (cutoff < Date.parse(snapshot.source_cutoff_at)) {
      report.skipped_newer_archives++; offset++; continue;
    }
    const messages = artifact.messages;
    const bytes = gzipSync(Buffer.from(JSON.stringify(messages)), { level: 9 });
    const attachmentCount = messages.reduce((sum, message) => sum + Number(message.attachments || 0), 0);
    const imageCount = messages.reduce((sum, message) => sum + Number(message.images || 0), 0);
    let customerMessageCount = 0, pageMessageCount = 0, customerMessagesReplied = 0;
    for (let index = 0; index < messages.length; index++) {
      if (messages[index].sender === 'page') pageMessageCount++;
      if (messages[index].sender !== 'customer') continue;
      customerMessageCount++;
      for (let next = index + 1; next < messages.length && messages[next].sender !== 'customer'; next++) {
        if (messages[next].sender === 'page') { customerMessagesReplied++; break; }
      }
    }
    report.archived_messages += messages.length;
    report.attachment_references += attachmentCount;
    report.image_references += imageCount;
    if (apply) batch.push({ contact_id: contact.id, page_id: contact.page_id, snapshot_generation: snapshot.generation, source_cutoff_at: artifact.source_cutoff_at,
      source_sha256: artifact.source_sha256, message_count: messages.length, customer_message_count: customerMessageCount,
      page_message_count: pageMessageCount, customer_messages_replied: customerMessagesReplied, attachment_count: attachmentCount,
      image_count: imageCount, messages_gzip_base64: bytes.toString('base64') });
    offset++;
    if (batch.length >= batchSize) await flush();
    if (offset % 500 === 0) {
      await flush();
      report.offset = offset; report.status = 'publishing';
      fs.writeFileSync(checkpointPath, JSON.stringify({ ...report, updated_at: new Date().toISOString() }, null, 2));
      console.log(JSON.stringify({ offset, sources: rows.length, matched_contacts: report.matched_contacts,
        archived_messages: report.archived_messages, skipped_newer_archives: report.skipped_newer_archives }));
    }
  }
  await flush();
  report.status = apply ? 'complete' : 'preflight_complete'; report.offset = offset;
  fs.writeFileSync(checkpointPath, JSON.stringify({ ...report, updated_at: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'failed'; report.error = error instanceof Error ? error.message : 'unknown_error';
  fs.writeFileSync(checkpointPath, JSON.stringify({ ...report, updated_at: new Date().toISOString() }, null, 2));
  console.error(JSON.stringify(report, null, 2)); process.exitCode = 1;
} finally { await db.end(); }
