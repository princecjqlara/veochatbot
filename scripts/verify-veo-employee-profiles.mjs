import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRequire } from 'node:module';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const origin = 'https://veochatbot.vercel.app', today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const from = new Date(Date.parse(launch.launch_at) + 8 * 3600000).toISOString().slice(0, 10);
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 45000 });
const report = { checked_at: new Date().toISOString(), passed: false, profiles: [], boundaries: [], errors: [], messages_dispatched: 0 };
async function auth(user) { return { Cookie: '__Secure-next-auth.session-token=' + await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 600, token: { id: user } }) }; }
async function get(query, headers) { const start = Date.now(), response = await fetch(origin + '/api/workspace/employee-profile?' + query, { headers, signal: AbortSignal.timeout(65000) }); return { status: response.status, body: await response.json(), duration_ms: Date.now() - start }; }
try {
    await db.connect();
    const tenant = (await db.query('SELECT launch_at FROM veo_tenants WHERE id=$1 AND owner_id=$2', [launch.id, launch.owner])).rows[0];
    assert.equal(tenant.launch_at.toISOString(), launch.launch_at);
    assert.equal((await db.query("SELECT has_function_privilege('anon','veo_employee_profile(uuid,uuid,date,date,uuid)','EXECUTE') OR has_function_privilege('authenticated','veo_employee_profile(uuid,uuid,date,date,uuid)','EXECUTE') exposed")).rows[0].exposed, false);
    const workers = (await db.query("SELECT user_id,role FROM veo_accounts WHERE tenant_id=$1 AND role IN('member','manager') ORDER BY user_id", [launch.id])).rows;
    assert(workers.length > 0, 'Existing workers are required');
    const root = await auth(launch.owner);
    for (const worker of workers) {
        const q = new URLSearchParams({ worker_id: worker.user_id, from, to: today });
        const r = await get(q, root); assert.equal(r.status, 200, r.body.error);
        assert.equal(r.body.employee.id, worker.user_id); assert(Array.isArray(r.body.days));
        const finance = (await db.query('SELECT veo_finance_days($1,$2,$3,NULL,$4) r', [launch.owner, from, today, worker.user_id])).rows[0].r;
        assert.equal(r.body.days.length, finance.days.length);
        for (const day of r.body.days) {
            const expected = finance.days.find(d => d.work_date === day.work_date); assert(expected);
            for (const key of ['closed', 'done', 'target', 'rate', 'qualified_closed', 'qualified_done']) assert.equal(day[key], expected[key]);
            assert.equal(day.rate, day.qualified_closed >= day.target && day.qualified_done >= day.target ? 40 : 35);
            for (const t of day.totals) { const e = expected.totals.find(x => x.currency === t.currency); assert(e); assert.equal(t.commission_minor, e.commission_minor); assert.equal(t.gross_minor, e.gross_minor); }
            if (day.closed + day.done === 0) assert.equal(day.rank, null);
        }
        assert(r.body.capacity.target >= 1);
        report.profiles.push({ role: worker.role, history_days: r.body.days.length, completed_average_days: r.body.completed_days, target: r.body.capacity.target, closed: r.body.summary.closed, done: r.body.summary.done, reply_capture_complete: r.body.reply_coverage.complete, duration_ms: r.duration_ms });
    }
    assert.equal((await get('worker_id=' + workers[0].user_id)).status, 401);
    assert.equal((await get('worker_id=invalid', root)).status, 400);
    const actors = (await db.query("SELECT user_id,role FROM veo_accounts WHERE tenant_id=$1 AND active AND role<>'owner'", [launch.id])).rows;
    for (const actor of actors) {
        const headers = await auth(actor.user_id), scope = (await db.query('SELECT veo_scope($1) r', [actor.user_id])).rows[0].r;
        const allowed = (await db.query("SELECT a.user_id FROM veo_accounts a WHERE a.user_id IN(SELECT veo_branch($1)) AND a.role IN('manager','member') LIMIT 1", [actor.user_id])).rows[0];
        if (allowed) {
            const profile = await get(new URLSearchParams({ worker_id: allowed.user_id, from, to: today }), headers);
            assert.equal(profile.status, 200, `${actor.role} permitted profile: ${profile.body.error || profile.status}`);
        }
        const branch = (await db.query('SELECT veo_branch($1) id', [actor.user_id])).rows.map(r => r.id);
        const forbidden = workers.find(w => !branch.includes(w.user_id));
        if (forbidden) assert.equal((await get('worker_id=' + forbidden.user_id, headers)).status, 403);
        const pg = launch.pages.find(p => !scope.page_ids.includes(p.id));
        if (pg && allowed) assert.equal((await get(`worker_id=${allowed.user_id}&page_id=${pg.id}`, headers)).status, 403);
        report.boundaries.push({ role: actor.role, allowed_profile_checked: Boolean(allowed), branch_denial_checked: Boolean(forbidden), page_denial_checked: Boolean(pg && allowed) });
    }
    const disabled = (await db.query('SELECT id FROM pages WHERE NOT veo_enabled LIMIT 1')).rows[0];
    if (disabled) assert.equal((await get(`worker_id=${workers[0].user_id}&page_id=${disabled.id}`, root)).status, 403);
    report.launch_unchanged = true; report.private_rpc = true; report.passed = true;
} catch (error) { report.errors.push(error.message); process.exitCode = 1; }
finally { await db.end(); fs.writeFileSync('.vercel/veo-employee-profile-verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
