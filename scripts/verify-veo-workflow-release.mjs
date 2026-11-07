// Production read verification only: no synthetic sales, receipts, messages,
// payments, Telegram dispatches or membership changes.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRequire } from 'node:module';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
const origin = 'https://veochatbot.vercel.app', result = { at: new Date().toISOString(), passed: false, checks: {}, manual_deliveries: 0 };
async function auth(id) { return { Cookie: '__Secure-next-auth.session-token=' + await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 1800, token: { id } }) }; }
async function get(path, headers) { const start = Date.now(), r = await fetch(origin + path, { headers, signal: AbortSignal.timeout(115000) }); const b = await r.json(); return { status: r.status, body: b, ms: Date.now() - start }; }
const nowDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
async function counts() { return (await db.query(`SELECT (SELECT count(*)::int FROM contact_verified_payments) AS retained_payments,
 (SELECT count(*)::int FROM veo_payments) AS payments,(SELECT count(*)::int FROM veo_orders) AS orders,
 (SELECT count(*)::int FROM veo_archive_records WHERE tenant_id=$1) AS archive,(SELECT launch_at FROM veo_tenants WHERE id=$1) AS launch`, [launch.id])).rows[0]; }
try {
    await db.connect(); const before = await counts(), root = await auth(launch.owner), today = nowDay();
    assert.equal(before.launch.getTime(), Date.parse(launch.launch_at));
    const scope = (await db.query('SELECT veo_scope($1) s', [launch.owner])).rows[0].s;
    assert.equal((await get('/api/workspace/receipts')).status, 401); assert.equal((await get('/api/workspace/warnings')).status, 401);
    assert.equal((await get('/api/workspace/business-orders')).status, 401);
    const receipts = await get('/api/workspace/receipts?' + new URLSearchParams({ from: new Date(Date.parse(launch.launch_at) + 8 * 3600000).toISOString().slice(0, 10), to: today }), root);
    assert.equal(receipts.status, 200, receipts.body.error); assert(Array.isArray(receipts.body.items));
    for (const r of receipts.body.items) { assert(!('object_path' in r)); assert(!('photo_sha256' in r)); if (r.salary_status === 'counted_from_verified_ledger') assert.equal(r.salary_holds.length, 0); }
    result.checks.receipts = { scoped_count: receipts.body.total, ms: receipts.ms, private_metadata: true };
    const warnings = await get('/api/workspace/warnings', root); assert.equal(warnings.status, 200, warnings.body.error); assert(Array.isArray(warnings.body.workers));
    result.checks.warnings = { workers: warnings.body.workers.length, obligations: warnings.body.workers.reduce((n, w) => n + w.warnings.length, 0), ms: warnings.ms };
    const workers = (await db.query("SELECT user_id,role FROM veo_accounts WHERE tenant_id=$1 AND active AND role<>'owner' ORDER BY role,user_id", [launch.id])).rows;
    for (const actor of workers) {
        const headers = await auth(actor.user_id), branch = (await db.query('SELECT veo_branch($1) id', [actor.user_id])).rows.map(r => r.id);
        const report = await get('/api/workspace/warnings', headers); assert.equal(report.status, 200); assert(report.body.workers.every(w => branch.includes(w.id)));
        if (actor.role === 'member') assert(report.body.workers.every(w => w.id === actor.user_id));
        if (actor.role !== 'team_leader') assert.equal((await get('/api/workspace/creatives?pageId=' + scope.page_ids[0], headers)).status, 403);
        if (['member', 'manager'].includes(actor.role)) {
            const commission = await get('/api/workspace/receipts?' + new URLSearchParams({ commission: '1', worker_id: actor.user_id, date: today }), headers);
            assert.equal(commission.status, 200, commission.body.error);
            assert.equal(commission.body.rate, commission.body.closed >= commission.body.target && commission.body.done >= commission.body.target ? 40 : 35);
            const finance = (await db.query('SELECT veo_finance_days($1,$2,$2,NULL,$1) f', [actor.user_id, today])).rows[0].f.days.find(d => d.user_id === actor.user_id);
            assert.deepEqual(commission.body.totals, finance?.totals || []);
        }
        const foreign = workers.find(w => !branch.includes(w.user_id)); if (foreign) assert.equal((await get('/api/workspace/warnings?worker_id=' + foreign.user_id, headers)).status, 403);
        if (foreign) assert.equal((await get('/api/workspace/receipts?commission=1&worker_id=' + foreign.user_id, headers)).status, 403);
    }
    result.checks.role_and_branch_isolation = true;
    result.checks.receipt_commission_and_page_scoped_totals = true;
    const businessContact = (await db.query('SELECT id FROM contacts WHERE page_id=ANY($1::uuid[]) ORDER BY last_interaction_at DESC NULLS LAST LIMIT 1', [scope.page_ids])).rows[0];
    if (businessContact) {
        const sources = await get('/api/workspace/business-orders?contact_id=' + businessContact.id, root);
        assert.equal(sources.status, 200, sources.body.error); assert(Array.isArray(sources.body.items));
        for (const row of sources.body.items) { assert(!('message_id' in row)); assert(!('access_token' in row)); assert(row.total_minor > 0); }
        result.checks.business_order_sources = { count: sources.body.items.length, private_metadata: true };
    }
    const page = (await db.query(`SELECT page_id FROM ad_source_catalog WHERE page_id=ANY($1::uuid[]) GROUP BY page_id ORDER BY count(*) DESC LIMIT 1`, [scope.page_ids])).rows[0]?.page_id || scope.page_ids[0];
    const creative = await get('/api/workspace/creatives?' + new URLSearchParams({ pageId: page, range: '7' }), root);
    assert.equal(creative.status, 200, creative.body.error); assert(Array.isArray(creative.body.ads)); assert(Array.isArray(creative.body.daily));
    for (const a of creative.body.ads) for (const f of a.finance) if (f.net_minor != null) { assert(f.spend_complete); assert.equal(f.net_minor, f.gross_minor - f.salary_minor - f.ad_spend_minor); }
    result.checks.creatives = { ads: creative.body.ads.length, days: creative.body.daily.length, ms: creative.ms, financial_arithmetic: true };
    const quota = (await db.query(`SELECT count(*)::int AS snapshots,count(*) FILTER(WHERE quota=0)::int AS no_work_quota,
 count(*) FILTER(WHERE quota>capacity OR quota<0)::int AS invalid FROM veo_operating_quotas WHERE work_date=veo_today()`)).rows[0]; assert.equal(quota.invalid, 0);
    result.checks.quota = quota;
    const privateFns = (await db.query(`SELECT count(*)::int AS exposed FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_receipt_save','veo_receipt_recheck','veo_receipt_note','veo_receipt_commission','veo_observe_business_orders','veo_business_orders_page','veo_workflow_warnings','veo_creative_inputs','veo_supply_target') AND(has_function_privilege('anon',oid,'EXECUTE') OR has_function_privilege('authenticated',oid,'EXECUTE'))`)).rows[0]; assert.equal(privateFns.exposed, 0);
    const after = await counts(); assert.equal(after.retained_payments, before.retained_payments); assert.equal(after.archive, before.archive); assert.equal(after.launch.getTime(), before.launch.getTime());
    result.checks.retained_finance_and_launch_unchanged = true; result.checks.private_functions = true; result.passed = true;
} catch (e) { result.error = e.message; process.exitCode = 1; }
finally { await db.end(); fs.writeFileSync('.vercel/veo-workflow-production-verification.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
