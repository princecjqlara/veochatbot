// A fresh, read-only ownership/schema inventory. This is not a data backup.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { LEGACY_SOURCE_PROJECT, VEO_TARGET_PROJECT, assertProjectCredentials } from './lib/database-migration-safety.mjs';
import { migrationConnectionOptions } from './lib/migration-retry.mjs';

const dir = path.resolve('.vercel/database-migration'); fs.mkdirSync(dir, { recursive: true });
const report = { run_id: process.argv.find(arg => arg.startsWith('--run-id='))?.slice(9) || randomUUID(), started_at: new Date().toISOString(),
 source_project: LEGACY_SOURCE_PROJECT, target_project: VEO_TARGET_PROJECT, read_only: true, passed: false,
 eligible_pages: [], ownership_gaps: [], data_export_completed: false, source_database_writes: 0, openrouter_calls: 0, customer_messages_sent: 0 };
const file = path.join(dir, 'source-inventory.json');
const flush = () => { const temporary = file + '.' + process.pid + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(report, null, 2)); fs.renameSync(temporary, file); };
let db;
try {
 const endpoint = assertProjectCredentials(process.env, LEGACY_SOURCE_PROJECT), options = await migrationConnectionOptions(endpoint.connectionString);
 const scope = JSON.parse(fs.readFileSync(path.join(dir, 'proposed-page-scope.json'), 'utf8'));
 if (scope.source_project !== LEGACY_SOURCE_PROJECT || scope.target_project !== VEO_TARGET_PROJECT || !Array.isArray(scope.pages) || !scope.pages.length) throw Error('Approved migration project scope is missing');
 const actor = JSON.parse(fs.readFileSync('.vercel/calendar-fix-actor.json', 'utf8'));
 if (!/^[0-9a-f-]{36}$/.test(actor.user_id) || !process.env.FACEBOOK_CLIENT_ID) throw Error('VeoBot Page ownership cannot be verified without its account and app identity');
 const ids = scope.pages.map(page => page.page_id);
 if (new Set(ids).size !== ids.length || ids.some(id => !/^[0-9a-f-]{36}$/.test(id))) throw Error('Proposed migration Page identities are invalid');
 const createClient = () => { const client = new pg.Client({ ...options, connectionTimeoutMillis: 6000, query_timeout: 15000, statement_timeout: 15000 }); client.on('error', () => {}); return client; };
 db = createClient(); await db.connect();
 const pages = (await db.query(`SELECT p.id,p.name,p.fb_page_id,p.access_token FROM public.pages p
  WHERE p.id=ANY($1::uuid[]) AND EXISTS(SELECT 1 FROM public.user_pages u WHERE u.page_id=p.id AND u.user_id=$2) ORDER BY p.id`, [ids, actor.user_id])).rows;
 await db.end(); db = null;
 const expected = new Map(scope.pages.map(page => [page.page_id, page.facebook_page_id]));
 for (const id of ids) if (!pages.some(page => page.id === id)) report.ownership_gaps.push({ page_id: id, reason: 'Current account membership is missing' });
 const bundle = path.join(dir, 'source-ownership-runtime.cjs');
 await build({ entryPoints: ['src/lib/facebook-page-connection.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
 const { verifyFacebookPageConnection, facebookWebhookConnectionStatus } = createRequire(import.meta.url)(bundle);
 const queue = [...pages];
 await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
  for (;;) {
   const page = queue.shift(); if (!page) break;
   try {
    if (expected.get(page.id) !== page.fb_page_id || !page.access_token) throw Error('Page identity or token is missing');
    await verifyFacebookPageConnection(page.fb_page_id, page.access_token);
    const subscription = await facebookWebhookConnectionStatus(page.fb_page_id, page.access_token, process.env.FACEBOOK_CLIENT_ID);
    if (subscription !== 'ready') throw Error(subscription === 'incomplete' ? 'This Page is not confirmed as subscribed to the VeoBot Facebook app' : 'The VeoBot app subscription could not be verified');
    report.eligible_pages.push({ page_id: page.id, facebook_page_id: page.fb_page_id, name: page.name, ownership_verified: true, messaging_access_verified: true });
   } catch (error) { report.ownership_gaps.push({ page_id: page.id, reason: error.code || 'OWNERSHIP_UNVERIFIED', detail: 'Page identity, inbox access or VeoBot app subscription needs verification' }); }
   flush();
  }
 }));
 if (report.ownership_gaps.length || report.eligible_pages.length !== ids.length) throw Error('Page scope requires review before any source records can be exported');
 db = createClient(); await db.connect(); await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await db.query("SET LOCAL statement_timeout='15s'; SET LOCAL timezone='UTC'");
 const current = (await db.query(`SELECT p.id,p.fb_page_id FROM public.pages p WHERE p.id=ANY($1::uuid[]) AND EXISTS(SELECT 1 FROM public.user_pages u WHERE u.page_id=p.id AND u.user_id=$2)`, [ids, actor.user_id])).rows;
 if (current.length !== ids.length || current.some(page => expected.get(page.id) !== page.fb_page_id)) throw Error('Page membership changed during ownership verification');
 report.snapshot = (await db.query('SELECT transaction_timestamp() AS at,txid_current_snapshot()::text AS identity')).rows[0];
 report.columns = (await db.query(`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default,is_generated,is_identity
  FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`)).rows;
 report.foreign_keys = (await db.query(`SELECT c.conname AS name,c.conrelid::regclass::text AS child,c.confrelid::regclass::text AS parent,pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.contype='f' AND n.nspname='public' ORDER BY 2,1`)).rows;
 report.counts = (await db.query(`SELECT
  (SELECT count(*)::text FROM contacts WHERE page_id=ANY($1::uuid[])) AS contacts,
  (SELECT count(*)::text FROM contact_tags t JOIN contacts c ON c.id=t.contact_id WHERE c.page_id=ANY($1::uuid[])) AS contact_tags,
  (SELECT count(*)::text FROM contact_verified_payments WHERE page_id=ANY($1::uuid[])) AS verified_payment_records,
  (SELECT count(*)::text FROM contact_purchases WHERE page_id=ANY($1::uuid[])) AS purchase_records,
  (SELECT count(*)::text FROM ad_daily_spend WHERE page_id=ANY($1::uuid[])) AS daily_ad_spend_records`, [ids])).rows[0];
 await db.query('ROLLBACK'); report.passed = true; report.completed_at = new Date().toISOString();
} catch (error) { if (db) await db.query('ROLLBACK').catch(() => {}); report.error = String(error.message).replace(/postgres(?:ql)?:\/\/\S+|eyJ[\w.-]+|EA[\w-]{25,}/g, '[redacted]'); report.code = error.code || null; process.exitCode = 1; }
finally { if (db) await Promise.race([db.end().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]); flush(); console.log(JSON.stringify({ ...report, columns: report.columns?.length, foreign_keys: report.foreign_keys?.length }, null, 2)); }
