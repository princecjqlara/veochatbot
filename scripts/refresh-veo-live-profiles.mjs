// Analyze complete Messenger histories locally before applying refreshed
// contact profiles. Database writes are available only after --prepare.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import pg from 'pg';
import { assertProjectCredentials, VEO_TARGET_PROJECT, digest } from './lib/database-migration-safety.mjs';
import { localPublicationRow, publishLocalBatch } from './lib/veo-local-publication.mjs';

const modes = ['--prepare', '--preflight', '--apply'].filter(value => process.argv.includes(value));
if (modes.length !== 1) throw Error('Choose exactly one of --prepare, --preflight, or --apply');
const mode = modes[0].slice(2), { connectionString } = assertProjectCredentials(process.env, VEO_TARGET_PROJECT);
const root = path.resolve('..'), liveDir = path.resolve('.vercel/historical-leads/live'), outDir = path.join(liveDir, 'profile-refresh');
fs.mkdirSync(outDir, { recursive: true });
const sourceText = fs.readFileSync(path.join(liveDir, 'sources.json'), 'utf8'), sourceHash = digest(sourceText);
const sources = JSON.parse(sourceText), pages = JSON.parse(fs.readFileSync('src/config/veo-pages.json', 'utf8'));
const approved = new Map(pages.filter(page => page.facebook_page_id).map(page => [page.facebook_page_id, page.name]));
if (!Array.isArray(sources) || !sources.length || sources.length > 20000) throw Error('A complete bounded live-history manifest is required');
const runtime = path.join(outDir, 'profile-runtime.cjs');
await build({ stdin: { contents: "export {analyzeContactBacklog,verifyBacklogArtifact,BACKLOG_ANALYSIS_VERSION} from './src/lib/contact-backlog-analysis';export {normalizeContactName} from './src/lib/contact-names';", resolveDir: process.cwd(), loader: 'ts' }, outfile: runtime, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { analyzeContactBacklog, verifyBacklogArtifact, BACKLOG_ANALYSIS_VERSION, normalizeContactName } = createRequire(import.meta.url)(runtime);
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 25000, query_timeout: 120000 });
db.on('error', () => {});
const manifestFile = path.join(outDir, 'manifest.jsonl'), statusFile = path.join(outDir, mode + '-status.json');
const report = { target_project: VEO_TARGET_PROJECT, mode, started_at: new Date().toISOString(), source_manifest_sha256: sourceHash, source_count: sources.length, reviewed: 0, customer_histories: 0, no_customer_history: 0, profile_rows: 0, published: 0, skipped: 0, evidence_messages: 0, errors: [], openrouter_calls: 0, customer_messages_sent: 0, financial_records_created: 0 };
const flush = () => fs.writeFileSync(statusFile, JSON.stringify({ ...report, updated_at: new Date().toISOString() }, null, 2));
const writeJson = (filename, content) => {
 const temporary = filename + '.' + process.pid + '.tmp'; fs.writeFileSync(temporary, content);
 try { fs.renameSync(temporary, filename); }
 catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; fs.copyFileSync(temporary, filename); fs.unlinkSync(temporary); }
};
const fileText = filename => { const data = fs.readFileSync(filename); return filename.endsWith('.gz') ? gunzipSync(data).toString('utf8') : data.toString('utf8'); };
function resolveSource(item) {
 const filename = path.resolve(root, item.file); if (!filename.startsWith(root + path.sep)) throw Error('History path escaped the workspace'); return filename;
}

try {
 await db.connect();
 await db.query('BEGIN READ ONLY');
 const dbPages = (await db.query('SELECT id,name,fb_page_id FROM pages')).rows;
 const pageByFb = new Map(dbPages.filter(page => page.fb_page_id && approved.has(page.fb_page_id)).map(page => [page.fb_page_id, page]));
 if (pageByFb.size !== 14) throw Error('The target database does not contain all 14 approved Facebook Pages');
 const configRows = (await db.query('SELECT page_id,details_to_collect,commercial_video_intake_enabled FROM chatbot_configs')).rows;
 const configs = new Map(configRows.map(row => [row.page_id, row]));
 const contactRows = (await db.query("SELECT id,page_id,psid,name,profile_pic,chatbot_enabled FROM contacts WHERE page_id=ANY($1::uuid[])",[[...pageByFb.values()].map(page => page.id)])).rows;
 await db.query('COMMIT');
 const identities = new Map(contactRows.map(row => [row.page_id + ':' + row.psid, row]));

 if (mode === 'prepare') {
  const prepared = [];
  for (const item of sources) {
   try {
    const page = pageByFb.get(item.fb_page_id); if (!page || page.id !== item.page_id || !approved.has(item.fb_page_id)) throw Error('Source is outside the approved Page scope');
    const identity = identities.get(item.page_id + ':' + item.psid); if (!identity) throw Error('Source does not match a retained contact');
    const filename = resolveSource(item), rawText = fileText(filename), source = JSON.parse(rawText);
    if (source.complete !== true || source.page_id !== item.page_id || source.fb_page_id !== item.fb_page_id || source.psid !== item.psid || !Array.isArray(source.messages)) throw Error('Complete source identity or messages are invalid');
    const cutoff = source.source_cutoff_at, sourceHash = digest(rawText), config = configs.get(item.page_id);
    const analysis = analyzeContactBacklog({ pageId: item.page_id, facebookPageId: item.fb_page_id, psid: item.psid, cutoff, messages: source.messages,
     requestedFields: Array.isArray(config?.details_to_collect) ? config.details_to_collect : [], commercialVideo: config?.commercial_video_intake_enabled === true });
    const artifact = { ...analysis, engine: BACKLOG_ANALYSIS_VERSION, page_id: item.page_id, facebook_page_id: item.fb_page_id, psid: item.psid,
     prepared_at: new Date().toISOString(), processing_complete: true, source_sha256: sourceHash, source_cutoff_at: cutoff, source_kind: 'live_graph_refresh',
     source_archive: path.relative(root, filename).replaceAll('\\', '/') };
    verifyBacklogArtifact(artifact);
    const artifactName = item.page_id + '_' + item.psid + '_' + sourceHash + '.profile.json.gz', artifactPath = path.join(outDir, artifactName);
    fs.writeFileSync(artifactPath, gzipSync(JSON.stringify(artifact)));
    const entry = { page_id: item.page_id, facebook_page_id: item.fb_page_id, psid: item.psid, identity_id: identity.id,
     source_file: path.relative(root, filename).replaceAll('\\', '/'), source_sha256: sourceHash,
     artifact_file: path.relative(root, artifactPath).replaceAll('\\', '/'), artifact_sha256: digest(fs.readFileSync(artifactPath)), source_cutoff_at: cutoff,
     message_count: artifact.messages.length, customer_message_count: artifact.payload.conversation.customer_message_count };
    prepared.push(entry); report.reviewed++; if (entry.customer_message_count) { report.customer_histories++; report.profile_rows++; } else report.no_customer_history++;
    if (report.reviewed % 100 === 0) { writeJson(manifestFile, prepared.map(row => JSON.stringify(row)).join('\n') + '\n'); flush(); console.log(JSON.stringify({ reviewed: report.reviewed, profiles: report.profile_rows, errors: report.errors.length })); }
   } catch (error) { report.errors.push({ page_id: item.page_id, psid: item.psid, error: error.message }); }
  }
  writeJson(manifestFile, prepared.map(row => JSON.stringify(row)).join('\n') + '\n');
  if (report.errors.length) report.status = 'failed'; else report.status = 'prepared_saved_locally';
  report.manifest_sha256 = digest(fs.readFileSync(manifestFile));
 } else {
  const prior = JSON.parse(fs.readFileSync(path.join(outDir, 'prepare-status.json'), 'utf8'));
  const text = fs.readFileSync(manifestFile, 'utf8'), manifestHash = digest(text), rows = text.split('\n').filter(Boolean).map(JSON.parse);
  if (prior.target_project !== VEO_TARGET_PROJECT || prior.status !== 'prepared_saved_locally' || prior.errors.length || prior.source_manifest_sha256 !== sourceHash || prior.manifest_sha256 !== manifestHash) throw Error('Complete locally saved analysis for this exact source manifest is required');
  report.manifest_sha256 = manifestHash; report.reviewed = prior.reviewed; report.customer_histories = prior.customer_histories; report.no_customer_history = prior.no_customer_history; report.profile_rows = prior.profile_rows;
  const batchSize = Number(process.argv.find(value => value.startsWith('--batch-size='))?.slice(13) || 50);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw Error('Choose a batch size between 1 and 100');
  let offset = 0;
  for (; offset < rows.length; offset += batchSize) {
   const batch = [], artifacts = [];
   for (const row of rows.slice(offset, offset + batchSize)) {
    if (!row.customer_message_count) continue;
    const page = pageByFb.get(row.facebook_page_id); if (!page || page.id !== row.page_id || !approved.has(row.facebook_page_id)) throw Error('Prepared Page identity is no longer approved');
    const identity = identities.get(row.page_id + ':' + row.psid); if (!identity || identity.id !== row.identity_id) throw Error('Prepared contact identity changed');
    const filename = resolveSource({ file: row.artifact_file }), bytes = fs.readFileSync(filename);
    if (digest(bytes) !== row.artifact_sha256) throw Error('Locally prepared profile changed');
    const artifact = JSON.parse(gunzipSync(bytes).toString('utf8')); verifyBacklogArtifact(artifact);
    batch.push(localPublicationRow(artifact, identity, normalizeContactName)); artifacts.push(artifact);
   }
   if (batch.length) {
    const result = await publishLocalBatch(db, batch, mode === 'apply');
    report.skipped += result.skipped;
    if (mode === 'apply') { report.published += result.published; report.evidence_messages += result.evidence_messages; }
   }
   report.status = mode === 'apply' ? 'publishing_profiles' : 'preflight_passed'; report.offset = Math.min(rows.length, offset + batchSize); flush();
   if (offset % (batchSize * 10) === 0) console.log(JSON.stringify({ mode, offset: report.offset, total: rows.length, published: report.published, skipped: report.skipped }));
  }
  report.status = mode === 'apply' ? 'complete' : 'complete';
 }
 report.finished_at = new Date().toISOString(); flush(); console.log(JSON.stringify(report));
 if (report.errors.length) process.exitCode = 1;
} catch (error) {
 await db.query('ROLLBACK').catch(() => {}); report.status = 'failed'; report.error = error.message; report.finished_at = new Date().toISOString(); flush(); console.error(JSON.stringify({ error: report.error })); process.exitCode = 1;
} finally { await db.end().catch(() => {}); }
