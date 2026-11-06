import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRequire } from 'node:module';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const receipt = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
const result = { verified_at: new Date().toISOString(), passed: false, checks: {} };
const origin = 'https://veochatbot.vercel.app', oldDay = '2026-07-09', month = '2026-07';
async function auth(id) { const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 600, token: { id } }); return { Cookie: `__Secure-next-auth.session-token=${token}; next-auth.session-token=${token}` }; }
async function read(query, headers) { const start = Date.now(), response = await fetch(origin + '/api/workspace/calendar?' + new URLSearchParams(query), { headers, signal: AbortSignal.timeout(115000) }); const text = await response.text(); let body; try { body = JSON.parse(text); } catch { throw new Error('Calendar returned a non-JSON response (' + response.status + ')'); } return { status: response.status, body, elapsed_ms: Date.now() - start, bytes: Buffer.byteLength(text) }; }
try {
    await db.connect(); await db.query('BEGIN READ ONLY');
    const scope = (await db.query('SELECT veo_scope($1) AS s', [receipt.owner])).rows[0].s;
    assert.equal(scope.role, 'owner'); assert.equal(Date.parse(scope.launch_at), Date.parse(receipt.launch_at));
    const expected = (await db.query(`SELECT count(*)::int AS inquiries,count(*) FILTER(WHERE(first_inquiry_at AT TIME ZONE 'Asia/Manila')::date=$2::date)::int AS selected FROM ad_lead_cohorts WHERE page_id=ANY($1::uuid[]) AND first_inquiry_at>='2026-07-01T00:00:00+08' AND first_inquiry_at<'2026-08-01T00:00:00+08'`, [scope.page_ids, oldDay])).rows[0];
    const staff = (await db.query("SELECT user_id,role FROM veo_accounts WHERE tenant_id=$1 AND active AND role IN('member','manager','team_leader') ORDER BY role", [receipt.id])).rows;
    const receipts = (await db.query(`SELECT p.currency,sum(CASE WHEN p.kind='refund' THEN -p.amount_minor ELSE p.amount_minor END)::bigint AS gross FROM contact_verified_payments p JOIN ad_lead_cohorts c ON c.id=p.contact_id AND c.page_id=p.page_id WHERE p.page_id=ANY($1::uuid[]) AND p.voided_at IS NULL AND(c.first_inquiry_at AT TIME ZONE 'Asia/Manila')::date=$2::date AND(p.occurred_at AT TIME ZONE 'Asia/Manila')::date>=$2::date AND p.occurred_at<$3::timestamptz GROUP BY p.currency`, [scope.page_ids, oldDay, scope.launch_at])).rows;
    const exposed = (await db.query("SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_calendar_inputs','veo_calendar_capture_message','veo_calendar_demographic_fields') AND(has_function_privilege('anon',oid,'EXECUTE') OR has_function_privilege('authenticated',oid,'EXECUTE'))")).rows[0].n;
    assert.equal(exposed, 0); await db.query('COMMIT');
    const headers = await auth(receipt.owner);
    assert.equal((await read({ month }, undefined)).status, 401);
    const historical = await read({ month, day: oldDay }, headers);
    assert.equal(historical.status, 200, historical.body.error); const data = historical.body;
    assert.equal(data.days.reduce((n, d) => n + d.inquiries, 0), expected.inquiries); assert.equal(data.selected.cohort.inquiries, expected.selected); assert.equal(data.selected.clients.length, expected.selected);
    assert.equal(data.pages.length, scope.page_ids.length); assert.equal(data.selected.demographics.length, 4); assert.equal(data.selected.touchpoints.length, 4);
    for (const d of data.selected.demographics) if (d.total) assert(Math.abs(d.rows.reduce((n, r) => n + r.percent, 0) - 1) < .000001);
    for (const r of receipts) { const actual = data.selected.cohort.finance.find(f => f.currency === r.currency); assert(actual && actual.received_minor >= Number(r.gross)); assert.equal(actual.salary_minor, null); }
    result.checks.historical_all_pages = { inquiries: expected.inquiries, cohort_clients: expected.selected, pages: data.pages.length, elapsed_ms: historical.elapsed_ms, response_bytes: historical.bytes, recorded_later_conversions: data.selected.cohort.converted_later, demographics_and_checkpoints: true, retained_salary_honestly_unavailable: true };
    const onePage = await read({ month, day: oldDay, page_id: scope.page_ids[0] }, headers); assert.equal(onePage.status, 200); assert.equal(onePage.body.pages.length, 1); assert(onePage.body.selected.cohort.inquiries <= expected.selected);
    result.checks.page_filter = true;
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), current = await read({ month: today.slice(0, 7), day: today }, headers);
    assert.equal(current.status, 200, current.body.error); assert.equal(current.body.selected.work_date, today); assert(Array.isArray(current.body.selected.top_members));
    result.checks.current_day = { elapsed_ms: current.elapsed_ms, inquiries: current.body.selected.inquiries, daily_message_metadata_coverage: current.body.selected.response.coverage_complete };
    for (const account of staff.filter(a => a.role !== 'team_leader')) assert.equal((await read({ month }, await auth(account.user_id))).status, 403);
    const leader = staff.find(a => a.role === 'team_leader'); if (leader) assert.equal((await read({ month: today.slice(0, 7), day: today }, await auth(leader.user_id))).status, 200);
    result.checks.role_permissions = true; result.checks.private_database_functions = true; result.passed = true;
} catch (e) { result.error = e.message; process.exitCode = 1; }
finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); fs.writeFileSync('.vercel/calendar-production-verification.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
