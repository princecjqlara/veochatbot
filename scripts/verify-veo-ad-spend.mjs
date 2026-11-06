import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pg from 'pg';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
if (!process.argv[2]) throw Error('Pass the completed refresh receipt path');
const refresh = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert(refresh.complete, 'The source refresh must finish before verification');
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, query_timeout: 30000, connectionTimeoutMillis: 15000 });
const result = { verified_at: new Date().toISOString(), passed: false, from: refresh.from, to: refresh.to, pages: 0, accounts: refresh.accounts, source_days: 0, currencies: [], live_months: [] };
try {
    await db.connect(); await db.query('BEGIN READ ONLY');
    const scope = (await db.query('SELECT veo_scope($1) s', [launch.owner])).rows[0].s;
    assert.deepEqual(scope.page_ids.slice().sort(), refresh.page_ids.slice().sort());
    result.pages = scope.page_ids.length;
    const days = Math.round((Date.parse(refresh.to) - Date.parse(refresh.from)) / 86400000) + 1;
    const coverage = (await db.query(`SELECT currency,count(*)::int AS row_count,count(DISTINCT spend_date)::int AS dates,count(DISTINCT page_id)::int AS pages,
        min(accounts_checked)::int AS accounts,sum(amount_minor)::text AS spend_minor FROM veo_ad_spend_coverage WHERE page_id=ANY($1::uuid[]) AND spend_date BETWEEN $2 AND $3 GROUP BY currency`, [scope.page_ids, refresh.from, refresh.to])).rows;
    assert(coverage.length > 0);
    for (const c of coverage) { assert.equal(c.row_count, days * scope.page_ids.length); assert.equal(c.dates, days); assert.equal(c.pages, scope.page_ids.length); assert.equal(c.accounts, refresh.accounts); }
    const reconciliation = (await db.query(`SELECT count(*)::int AS rows,count(*) FILTER(WHERE (r->>'spend_date')::date<veo_today() AND NOT (r->>'complete')::boolean)::int AS incomplete_closed_dates
        FROM jsonb_array_elements(veo_calendar_spend($1,$2,$3)) r`, [scope.page_ids, refresh.from, refresh.to])).rows[0];
    assert.equal(reconciliation.rows, days * scope.page_ids.length * coverage.length);
    assert.equal(reconciliation.incomplete_closed_dates, 0, 'A closed date has incomplete or unreconciled spend');
    result.source_days = days; result.currencies = coverage;
    await db.query('COMMIT');
    const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 600, token: { id: launch.owner } });
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const middle = new Date((Date.parse(refresh.from) + Date.parse(refresh.to)) / 2).toISOString().slice(0, 7);
    for (const month of [...new Set([refresh.from.slice(0, 7), middle, refresh.to.slice(0, 7)])]) {
        const day = month === today.slice(0, 7) ? today : month + '-09';
        const start = Date.now(), response = await fetch('https://veochatbot.vercel.app/api/workspace/calendar?' + new URLSearchParams({ month, day }), {
            headers: { Cookie: '__Secure-next-auth.session-token=' + token }, signal: AbortSignal.timeout(115000) });
        const body = await response.json(); assert.equal(response.status, 200, body.error); assert.equal(body.pages.length, result.pages);
        const expected = (await db.query(`SELECT spend_date::text,currency,sum(amount_minor)::text AS amount_minor FROM veo_ad_spend_coverage
            WHERE page_id=ANY($1::uuid[]) AND to_char(spend_date,'YYYY-MM')=$2 GROUP BY spend_date,currency`, [scope.page_ids, month])).rows;
        for (const e of expected) {
            const actual = body.days.find(d => d.work_date === e.spend_date)?.finance.find(f => f.currency === e.currency);
            assert(actual, 'A fetched spend date is missing from the calendar'); assert.equal(actual.ad_spend_minor, Number(e.amount_minor));
            assert.equal(actual.spend_complete, e.spend_date < today); assert.equal(actual.spend_accounts_checked, refresh.accounts);
        }
        result.live_months.push({ month, verified_daily_currency_totals: expected.length, elapsed_ms: Date.now() - start });
    }
    result.passed = true;
} catch (e) { result.error = e.message; process.exitCode = 1; }
finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); fs.writeFileSync('.vercel/veo-ad-spend-verification.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
