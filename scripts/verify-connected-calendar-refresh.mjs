// Read-only production verification after the connected-source repair finishes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pg from 'pg';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const dir = path.resolve('.vercel/historical-leads'), inventory = JSON.parse(fs.readFileSync(path.join(dir, 'live/list-receipt.json'), 'utf8'));
const report = { started_at: new Date().toISOString(), read_only: true, scope: 'connected_pages', passed: false, cases: [], openrouter_calls: 0, customer_messages_sent: 0, financial_records_created: 0 };
const flush = () => fs.writeFileSync(path.join(dir, 'calendar-refresh-verification.json'), JSON.stringify(report, null, 2));
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 7000, query_timeout: 20000 }); db.on('error', () => {});
try {
 assert(inventory.passed && inventory.coverage_complete && inventory.scope_check_complete, 'A complete connected-inbox scan is required before calendar verification');
 assert(Number.isFinite(Date.parse(inventory.completed_at)) && Date.now() - Date.parse(inventory.completed_at) < 86400000, 'Connected-inbox verification is stale');
 const ids = inventory.pages.map(page => page.page_id); assert(ids.length > 0 && ids.every(id => /^[0-9a-f-]{36}$/.test(id)), 'Connected Page IDs are missing');
 await db.connect();
 const memberships = (await db.query('SELECT DISTINCT ON(page_id) page_id,user_id FROM user_pages WHERE page_id=ANY($1::uuid[]) ORDER BY page_id,user_id', [ids])).rows;
 assert.equal(memberships.length, ids.length, 'A Page lost its authorized membership before verification');
 const now = new Date(Date.now() + 8 * 3600000), currentMonth = now.toISOString().slice(0, 7), priorMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
 const cookies = new Map();
 for (const membership of memberships) {
  if (!cookies.has(membership.user_id)) cookies.set(membership.user_id, await encode({ token: { id: membership.user_id, name: 'Calendar data verification' }, secret: process.env.NEXTAUTH_SECRET, maxAge: 3600 }));
  for (const month of [priorMonth, currentMonth]) {
   const [year, number] = month.split('-').map(Number), from = new Date(Date.UTC(year, number - 1, 1) - 8 * 3600000).toISOString(), to = new Date(Date.UTC(year, number, 1) - 8 * 3600000).toISOString();
   const response = await fetch('https://veochatbot.vercel.app/api/ad-calendar?' + new URLSearchParams({ month, pageId: membership.page_id }), { headers: { Cookie: '__Secure-next-auth.session-token=' + cookies.get(membership.user_id) }, signal: AbortSignal.timeout(95000) });
   const body = await response.json(); assert.equal(response.status, 200, body.error || 'Calendar is unavailable');
   assert(Number.isFinite(Date.parse(body.outcome_as_of)), 'Calendar outcome cutoff is missing');
   const expected = (await db.query(`SELECT count(*)::int AS inquiries FROM contacts c
    LEFT JOIN ad_contact_sources s ON s.contact_id=c.id AND s.page_id=c.page_id
    WHERE c.page_id=$1 AND c.created_at<=$4::timestamptz
     AND (CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END)>=$2::timestamptz
     AND (CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END)<least($3::timestamptz,$4::timestamptz)`, [membership.page_id, from, to, body.outcome_as_of])).rows[0].inquiries;
   assert.equal(body.overall.inquiries, expected, 'Calendar inquiry count differs from the recorded contact/source inventory');
   for (const key of ['inquiries', 'converted', 'confirmed_payers', 'payers', 'orders']) {
    assert.equal(body.days.reduce((sum, day) => sum + day.overall[key], 0), body.overall[key], 'Calendar daily and monthly totals differ: ' + key);
    assert(body.overall[key] <= body.overall.inquiries, 'Calendar outcomes exceed their inquiry cohort');
   }
   assert(body.overall.payers <= body.overall.confirmed_payers, 'Verified payers exceed confirmed customers');
   assert(body.overall.spend.complete || body.overall.profit === null && body.overall.gross_roas === null && body.overall.net_roas === null, 'Incomplete spend supplied financial returns');
   assert(!body.overall.confirmed_customers_without_receipts || body.overall.profit === null, 'Missing receipts supplied verified profit');
   report.cases.push({ page_id: membership.page_id, month, inquiries: expected, converted: body.overall.converted, confirmed_customers: body.overall.confirmed_payers, spend_complete: body.overall.spend.complete, report_as_of: body.outcome_as_of }); flush();
  }
 }
 report.passed = true; report.completed_at = new Date().toISOString();
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally { await Promise.race([db.end().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]); flush(); console.log(JSON.stringify(report, null, 2)); }
