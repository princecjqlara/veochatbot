// Read existing live service state and roll back menu rendering. No delivery.
import fs from 'node:fs';
import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
const tenant = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8')).id;
const authIndex = process.argv.indexOf('--auth-env');
const auth = authIndex < 0 ? process.env : parseEnv(fs.readFileSync(process.argv[authIndex + 1], 'utf8'));
const origin = auth.VEO_JAUCIAN_URL || 'https://jaucianassitant.vercel.app';
const report = { at: new Date().toISOString(), manualDispatch: false, messagesSent: 0 };
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
 ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, query_timeout: 20000 });
try {
 // Queue retrieval is part of bot health even when the delivery outbox is empty.
 // A healthy scheduler alone does not prove that VEO can return client offers.
 const pending = await fetch('https://veochatbot.vercel.app/api/workspace/handoff', {
  method: 'POST', headers: { Authorization: 'Bearer ' + auth.VEO_JAUCIAN_SECRET, 'Content-Type': 'application/json' },
  body: JSON.stringify({ resource: 'intake', tenant_id: tenant, action: 'pending', data: {} }), signal: AbortSignal.timeout(18000)
 });
 const notifications = await pending.json();
 report.pending = { http: pending.status, offers: notifications.offers?.length, notices: notifications.notices?.length };
 assert.equal(pending.status, 200, 'The live client-offer endpoint must be reachable');
 assert.equal(notifications.tenant_id, tenant);assert.equal(notifications.ok, true);
 assert(Array.isArray(notifications.offers) && Array.isArray(notifications.notices));
 const workforce = await fetch(origin + '/api/veo/workspace?' + new URLSearchParams({ tenant_id: tenant, resource: 'workforce', offset: '0', limit: '8' }),
  { headers: { Authorization: 'Bearer ' + auth.VEO_JAUCIAN_SECRET }, signal: AbortSignal.timeout(25000) });
 const body = await workforce.json();
 report.workforce = { http: workforce.status, workers: body.workers?.length, confirmed: body.workers?.filter(w => w.membership_confirmed).length };
 assert.equal(workforce.status, 200, 'Workforce verification must succeed');assert(Array.isArray(body.workers));
 const health = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(20000) });
 report.health = { http: health.status, body: await health.json() };assert.equal(health.status, 200);
 await db.connect();await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='15s'");
 report.sync = (await db.query('SELECT last_sync_at,last_error,counts,auto_checked_at,auto_last_error FROM veo_telegram_sync_state WHERE tenant_id=$1', [tenant])).rows[0];
 assert.equal(report.sync.last_error, null, 'The ordinary workforce scheduler must recover');
 assert(Date.now() - new Date(report.sync.last_sync_at).getTime() < 10 * 60000, 'Scheduled workforce verification must be current');
 const actor = (await db.query("SELECT r.chat_id,m.telegram_user_id FROM veo_telegram_intake_requests r JOIN veo_worker_mappings m ON m.user_id=r.actor_id JOIN veo_accounts a ON a.user_id=r.actor_id AND a.role IN('member','manager') WHERE r.tenant_id=$1 ORDER BY r.created_at DESC LIMIT 1", [tenant])).rows[0];
 assert(actor, 'An existing mapped client-controls user is required');
 const request = randomUUID();
 await db.query("SELECT veo_telegram_intake($1,$2,$3,'pool',$4::jsonb)", [tenant, actor.telegram_user_id, actor.chat_id, JSON.stringify({ request_id: request })]);
 const rendered = (await db.query("SELECT veo_telegram_intake($1,$2,$3,'render',$4::jsonb) value", [tenant, actor.telegram_user_id, actor.chat_id, JSON.stringify({ request_id: request })])).rows[0].value;
 report.render = { multiline: rendered.text.includes('\n'), literalNewlines: rendered.text.includes('\\n'),
  queueExplained: rendered.text.includes('Waiting for your automatic editor offer'), buttonCount: rendered.reply_markup.inline_keyboard.flat().length, rolledBack: true };
 assert(report.render.multiline && !report.render.literalNewlines);
 assert(rendered.reply_markup.inline_keyboard.flat().every(b => b.url || /^vi:[a-f0-9-]{36}$/.test(b.callback_data)));
 const forbidden = (await db.query(`SELECT count(*)::int n FROM veo_telegram_intake_tokens t JOIN veo_intake_dispatch d ON d.contact_id=t.contact_id
  WHERE t.request_id=$1 AND t.action IN('accept','choose_worker') AND t.offer_id IS NULL AND d.status IN('waiting','offered')`, [request])).rows[0].n;
 assert.equal(forbidden, 0, 'Automatic queue clients must not expose unusable direct acceptance buttons');
 await db.query('ROLLBACK');report.passed = true;
} catch (error) {
 await db.query('ROLLBACK').catch(() => {});report.passed = false;report.error = error.message;process.exitCode = 1;
} finally {
 await db.end();
 const artifact = JSON.stringify(report, null, 2);
 fs.writeFileSync('.vercel/telegram-client-controls-live-verification.json', artifact);
 fs.writeFileSync('.vercel/telegram-client-controls-check-' + report.at.replace(/[:.]/g, '-') + '.json', artifact);
 console.log(artifact);
}
