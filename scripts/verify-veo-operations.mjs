import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRequire } from 'node:module';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const receipt = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const origin = 'https://veochatbot.vercel.app', day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 45000 });
const result = { verified_at: new Date().toISOString(), checks: {}, passed: false };
async function headers(id) { const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 300, token: { id } }); return { Cookie: `__Secure-next-auth.session-token=${token}; next-auth.session-token=${token}` }; }
async function get(path, auth) { const response = await fetch(origin + path, { headers: auth, signal: AbortSignal.timeout(90000) }); const body = await response.json(); return { status: response.status, body }; }
try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    const tenant = (await db.query('SELECT owner_id,launch_at FROM veo_tenants WHERE id=$1', [receipt.id])).rows[0];
    assert.equal(tenant.owner_id, receipt.owner); assert.equal(tenant.launch_at.toISOString(), receipt.launch_at);
    const installed = (await db.query("SELECT count(*)::int AS n FROM app_private.schema_migrations WHERE version BETWEEN '202611050020' AND '202611050024'")).rows[0].n;
    assert.equal(installed, 5);
    const accounts = (await db.query('SELECT user_id,role FROM veo_accounts WHERE tenant_id=$1 AND active ORDER BY role', [receipt.id])).rows;
    const privateFunctions = ['veo_offboard', 'veo_apply_telegram_observations', 'veo_operations', 'veo_calendar_finance', 'veo_page_capacity', 'veo_budget_action', 'veo_operations_report'];
    const exposed = (await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) AND(has_function_privilege('anon',oid,'EXECUTE') OR has_function_privilege('authenticated',oid,'EXECUTE'))", [privateFunctions])).rows[0].n;
    assert.equal(exposed, 0);
    const retained = (await db.query("SELECT count(*)::int AS n FROM veo_archive_records WHERE tenant_id=$1 AND source_table='contact_verified_payments'", [receipt.id])).rows[0].n;
    assert.equal(retained, 658);
    const queue = (await db.query("SELECT count(*) FILTER(WHERE status='queued')::int AS queued,count(*) FILTER(WHERE status='processing')::int AS processing,count(*) FILTER(WHERE status='error')::int AS errors FROM veo_event_inbox")).rows[0];
    await db.query('COMMIT');
    result.checks.retained_cutoff_owner_archive_and_private_functions = true;
    result.collection = queue;
    const owner = await headers(receipt.owner);
    const operations = await get(`/api/workspace/operations?from=${day}&to=${day}`, owner);
    assert.equal(operations.status, 200); assert(Array.isArray(operations.body.finance.days)); assert(Array.isArray(operations.body.page_rankings));
    assert(operations.body.finance.days.every(d => d.target >= 1 && d.rate === (d.qualified_closed >= d.target && d.qualified_done >= d.target ? 40 : 35)));
    result.checks.daily_salary_rankings_and_work_tracking = true;
    const calendar = await get(`/api/workspace/operations?view=calendar&month=${day.slice(0, 7)}`, owner);
    assert.equal(calendar.status, 200); assert(calendar.body.days.length >= 28); assert(calendar.body.source.includes('actual worker commission'));
    result.checks.actual_salary_calendar = true;
    const [budget, workspace] = await Promise.all([get(`/api/workspace/budget?date=${day}`, owner), get('/api/workspace', owner)]);
    assert.equal(budget.status, 200); assert.equal(workspace.status, 200);
    const plans = budget.body.plans;
    for (const team of workspace.body.capacity.teams) {
        const pagePlans = plans.filter(p => p.team_id === team.id);
        assert.equal(pagePlans.reduce((n, p) => n + p.full_capacity, 0), team.capacity);
        assert.equal(pagePlans.reduce((n, p) => n + p.quota, 0), team.quota.closed);
        assert.equal(team.quota.closed, team.quota.done);
    }
    result.checks.page_budget_team_quota_conservation = true;
    const boundary = [];
    for (const account of accounts.filter(a => a.role !== 'owner')) {
        const auth = await headers(account.user_id);
        const scope = (await db.query('SELECT veo_scope($1) AS s', [account.user_id])).rows[0].s;
        if (['member', 'manager'].includes(account.role)) {
            for (const path of ['/api/workspace/operations?view=calendar', '/api/workspace/budget', '/api/ad-quality', '/api/ad-calendar']) assert.equal((await get(path, auth)).status, 403);
        } else if (account.role === 'team_leader') {
            assert.equal((await get('/api/workspace/operations?view=calendar', auth)).status, 200);
            assert.equal((await get('/api/workspace/budget', auth)).status, 200);
            if (scope.page_ids[0]) assert.equal((await get('/api/ad-quality?range=7&pageId=' + scope.page_ids[0], auth)).status, 200);
            const foreign = receipt.pages.find(p => !scope.page_ids.includes(p.id));
            if (foreign) for (const path of ['/api/workspace/operations?view=calendar&page_id=', '/api/ad-quality?pageId=']) assert.equal((await get(path + foreign.id, auth)).status, 403);
        }
        boundary.push(account.role);
    }
    result.checks.role_and_page_boundaries = boundary;
    const secretHeaders = { Authorization: `Bearer ${process.env.VEO_JAUCIAN_SECRET}` };
    const report = await get(`/api/workspace/handoff?tenant_id=${receipt.id}&report_date=${day}&include_operations=1`, secretHeaders);
    assert.equal(report.status, 200); assert.equal(report.body.report_version, 2); assert(report.body.teams.every(t => t.access_signature));
    const workforceResponse = await fetch(`https://jaucianassitant.vercel.app/api/veo/workspace?tenant_id=${receipt.id}&resource=workforce&limit=8`, { headers: secretHeaders, signal: AbortSignal.timeout(90000) });
    const workforce = await workforceResponse.json(); assert.equal(workforceResponse.status, 200); assert.equal(workforce.tenant_id, receipt.id); assert(Array.isArray(workforce.workers));
    result.checks.authoritative_shift_reports_and_existing_bot_workforce = true;
    result.telegram_mapping = { mapped: workforce.mapped_total, unmapped: workforce.unmapped, teams: workspace.body.teams.filter(t => t.telegram_chat_id).length };
    result.passed = true;
} catch (error) { result.error = error.message; process.exitCode = 1; }
finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); fs.writeFileSync('.vercel/operations-production-verification.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
