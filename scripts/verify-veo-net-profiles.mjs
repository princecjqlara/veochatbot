// Public production verification. No payment changes or customer/Telegram sends.
// --analyze refreshes one already enrolled profile from saved customer messages.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRequire } from 'node:module';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const origin = 'https://veochatbot.vercel.app';
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
const report = { checked_at: new Date().toISOString(), passed: false, checks: {}, manual_customer_or_telegram_sends: 0 };
async function request(path, headers, body) {
    const r = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { ...headers, ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(115000) });
    const text = await r.text(); let parsed; try { parsed = JSON.parse(text); } catch { throw Error('Non-JSON response: ' + r.status); }
    return { status: r.status, body: parsed };
}
async function financialCounts() {
    return (await db.query(`SELECT (SELECT count(*)::int FROM contact_purchases) AS retained_orders,
        (SELECT count(*)::int FROM contact_verified_payments) AS retained_payments,
        (SELECT count(*)::int FROM veo_orders) AS orders,(SELECT count(*)::int FROM veo_payments) AS payments,
        (SELECT launch_at FROM veo_tenants WHERE id=$1) AS launch_at`, [launch.id])).rows[0];
}
function financialArithmetic(rows, cohort = false) {
    let known = 0, unavailable = 0;
    for (const row of rows) {
        const revenue = cohort ? row.received_minor : row.gross_minor;
        if (row.net_minor != null) {
            assert.equal(row.spend_complete, true); assert.notEqual(row.salary_minor, null);
            assert.equal(row.net_minor, revenue - row.salary_minor - row.ad_spend_minor); known++;
        } else unavailable++;
        if (row.net_roas != null) {
            assert.equal(row.spend_complete, true); assert(row.ad_spend_minor > 0); assert.notEqual(row.salary_minor, null);
            assert(Math.abs(row.net_roas - (revenue - row.salary_minor) / row.ad_spend_minor) < 1e-9);
        }
        if (row.salary_minor == null || !row.spend_complete || !row.ad_spend_minor) assert.equal(row.net_roas, null);
    }
    return { known, unavailable };
}
function verifyProfile(data) {
    assert(Array.isArray(data.contact.tags)); assert('pipeline_stage' in data.contact); assert(Array.isArray(data.facts));
    assert(data.best_contact_time?.value); assert(data.auto_fill?.fields?.some(f => f.key === 'buying_purpose'));
    assert(data.auto_fill.fields.some(f => f.key === 'problems_encountered')); assert(data.auto_fill.fields.some(f => f.key === 'best_contact_time'));
    assert.equal(new Set(data.auto_fill.fields.map(f => f.key)).size, data.auto_fill.fields.length);
    let paidOrders = 0;
    for (const metric of data.finance.metrics.currencies) {
        const orders = data.finance.metrics.orders.filter(o => o.currency === metric.currency && o.ever_paid);
        assert.equal(metric.net_minor, metric.received_minor - metric.refunded_minor);
        assert.equal(metric.paid_order_count, orders.length); paidOrders += orders.length;
        assert.equal(metric.average_order_minor, orders.length ? orders.reduce((n, o) => n + o.total_minor, 0) / orders.length : null);
        assert.equal(metric.average_paid_minor, orders.length ? orders.reduce((n, o) => n + o.paid_minor, 0) / orders.length : null);
    }
    return { lead_stage_available: true, tags_available: true, distinct_auto_fill_fields: data.auto_fill.fields.length, paid_orders: paidOrders, average_order_value_and_verified_ltv: true, best_time_source: data.best_contact_time.source };
}
try {
    await db.connect();
    const before = await financialCounts(), scope = (await db.query('SELECT veo_scope($1) AS s', [launch.owner])).rows[0].s;
    assert.equal(scope.role, 'owner'); assert.equal(Date.parse(before.launch_at), Date.parse(launch.launch_at));
    const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 1200, token: { id: launch.owner } });
    const headers = { Cookie: '__Secure-next-auth.session-token=' + token };
    const enrolled = (await db.query(`SELECT d.contact_id AS id,d.page_id FROM veo_contact_demographics d JOIN contacts c ON c.id=d.contact_id
        WHERE d.page_id=ANY($1::uuid[]) AND EXISTS(SELECT 1 FROM veo_event_inbox e WHERE e.page_id=d.page_id
        AND c.psid=coalesce(e.payload#>>'{entry,0,messaging,0,sender,id}',e.payload#>>'{entry,0,standby,0,sender,id}')
        AND coalesce(e.payload#>>'{entry,0,messaging,0,message,text}',e.payload#>>'{entry,0,standby,0,message,text}')~*'need|gusto|business|negosyo|para sa|company|promo')
        ORDER BY c.last_interaction_at DESC NULLS LAST LIMIT 1`, [scope.page_ids])).rows[0];
    assert(enrolled, 'An enrolled source-bearing contact is needed');
    const paid = (await db.query(`SELECT p.contact_id AS id,p.page_id FROM contact_verified_payments p WHERE p.page_id=ANY($1::uuid[]) AND p.voided_at IS NULL AND p.purchase_id IS NOT NULL AND p.kind<>'refund' ORDER BY p.occurred_at DESC LIMIT 1`, [scope.page_ids])).rows[0];
    assert(paid, 'Retained verified order is needed');
    const autoPath = '/api/workspace/profile-details?contact_id=' + enrolled.id;
    assert.equal((await request(autoPath)).status, 401);
    const metadata = await request(autoPath, headers); assert.equal(metadata.status, 200);
    const duplicate = await request('/api/workspace/profile-details', headers, { contact_id: enrolled.id, action: 'request', label: 'Purpose' });
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
    assert.deepEqual(duplicate.body.requested_fields, metadata.body.requested_fields);
    const foreign = (await db.query('SELECT id FROM contacts WHERE NOT(page_id=ANY($1::uuid[])) LIMIT 1', [scope.page_ids])).rows[0];
    if (foreign) assert.equal((await request('/api/workspace/profile-details?contact_id=' + foreign.id, headers)).status, 403);
    const privateAccess = (await db.query(`SELECT count(*)::int AS exposed FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_profile_detail_access','veo_profile_detail_request','veo_demographic_sources','veo_demographic_sources_base') AND(has_function_privilege('anon',oid,'EXECUTE') OR has_function_privilege('authenticated',oid,'EXECUTE'))`)).rows[0];
    assert.equal(privateAccess.exposed, 0);
    report.checks.auth_scope_and_duplicates = true;
    const profiles = [];
    for (const contact of [enrolled, paid]) {
        const profile = await request(`/api/pages/${contact.page_id}/contacts/${contact.id}/profile`, headers); assert.equal(profile.status, 200);
        profiles.push(verifyProfile(profile.body));
    }
    assert(profiles.some(p => p.paid_orders > 0)); report.checks.profiles = profiles;
    if (process.argv.includes('--analyze')) {
        const queued = await request('/api/workspace/profile-details', headers, { contact_id: enrolled.id, action: 'refresh' });
        assert.equal(queued.status, 202);
        assert(process.env.CRON_SECRET, 'Profile worker authentication is required');
        const run = await request('/api/cron/contact-profiles', { Authorization: 'Bearer ' + process.env.CRON_SECRET });
        assert.equal(run.status, 200); assert.equal(run.body.failed, 0); assert.equal(run.body.historical_imports, 0);
        report.checks.saved_source_worker = { processed: run.body.processed, failed: 0, historical_imports: 0 };
        const job = (await db.query('SELECT status,source_hash,fields,analyzed_version FROM veo_contact_demographics WHERE contact_id=$1', [enrolled.id])).rows[0];
        assert(job.analyzed_version >= queued.body.analysis.requested_version); assert(job.source_hash?.startsWith('profile-v2:'));
        const details = await request(autoPath, headers); assert.equal(details.status, 200);
        report.checks.saved_source_worker.grounded_fields = job.fields.length;
        report.checks.saved_source_worker.profile_fields = details.body.fields.filter(f => f.source === 'ai').map(f => f.key);
    }
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const current = await request('/api/workspace/calendar?' + new URLSearchParams({ month: today.slice(0, 7), day: today }), headers);
    assert.equal(current.status, 200); assert.equal(current.body.pages.length, scope.page_ids.length);
    let known = 0, unavailable = 0;
    for (const day of current.body.days) {
        const daily = financialArithmetic(day.finance), cohort = financialArithmetic(day.cohort_finance, true);
        known += daily.known + cohort.known; unavailable += daily.unavailable + cohort.unavailable;
        assert(Array.isArray(day.salary_rates));
        for (const rate of day.salary_rates) { assert([35, 40].includes(rate.rate)); assert(rate.workers > 0); assert(Array.isArray(rate.totals)); }
    }
    financialArithmetic(current.body.selected.cohort.finance, true);
    report.checks.net_calendar = { pages: current.body.pages.length, days: current.body.days.length, known_financial_rows: known, unavailable_financial_rows: unavailable, arithmetic_and_actual_rates: true };
    assert.deepEqual(await financialCounts(), before); report.checks.finance_and_launch_unchanged = true;
    report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally { await db.end(); fs.writeFileSync('.vercel/veo-net-profile-production-verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
