// Read-only deployed checks. Does not call the worker or send customer messages.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { encode } from 'next-auth/jwt';
const imported = await import('../src/lib/chatbot-pricing.ts');
const { validatePricingExperiment } = imported.validatePricingExperiment ? imported : imported.default;
const origin = 'https://veochatbot.vercel.app';
const project = JSON.parse(await readFile(new URL('../.vercel/project.json', import.meta.url), 'utf8'));
const auth = JSON.parse(await readFile(path.join(process.env.APPDATA, 'com.vercel.cli', 'Data', 'auth.json'), 'utf8'));
const deploymentResponse = await fetch('https://api.vercel.com/v13/deployments/veochatbot.vercel.app?teamId=' + project.orgId,
    { headers: { Authorization: 'Bearer ' + auth.token }, signal: AbortSignal.timeout(20000) });
assert.equal(deploymentResponse.status, 200);
const deployment = await deploymentResponse.json();
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
assert.equal(deployment.readyState, 'READY');
assert.equal(deployment.gitSource?.sha || deployment.meta?.githubCommitSha, sha, 'Live app must match this release');
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_6543 || process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
await db.connect();
try {
    await db.query('BEGIN READ ONLY');
    const receipt = JSON.parse(await readFile(new URL('../../data/pricing-activation-2026-10-22.json', import.meta.url), 'utf8'));
    const backup = JSON.parse(await readFile(new URL('../../data/' + receipt.backup, import.meta.url), 'utf8'));
    const pages = (await db.query('SELECT c.*,p.name,u.user_id FROM public.chatbot_configs c JOIN public.pages p ON p.id=c.page_id JOIN LATERAL(SELECT user_id FROM public.user_pages WHERE page_id=p.id LIMIT 1)u ON true WHERE c.commercial_video_intake_enabled ORDER BY c.page_id')).rows;
    assert.equal(pages.length, receipt.activated.length);
    const results = [];
    let dashboardVerified = false;
    for (const page of pages) {
        const before = backup.configs.find(config => config.page_id === page.page_id);
        for (const key of ['enabled', 'follow_up_enabled', 'trial_mode_enabled', 'trial_contact_id', 'follow_up_first_day_mode',
            'follow_up_quick_delays_minutes', 'follow_up_best_time_days', 'policy_revision']) assert.deepEqual(page[key], before[key], 'Preserve ' + key);
        const token = await encode({ secret: process.env.NEXTAUTH_SECRET, token: { id: page.user_id, name: 'Pricing release verification' }, maxAge: 600 });
        const headers = { Cookie: '__Secure-next-auth.session-token=' + token };
        const response = await fetch(origin + '/api/pages/' + page.page_id + '/chatbot/pricing', { headers, signal: AbortSignal.timeout(30000) });
        const body = await response.json();
        assert.equal(response.status, 200, body.error);
        const planned = backup.planned.find(row => row.pageId === page.page_id);
        const actual = validatePricingExperiment({ ...body.experiment, packages: body.packages.map(pkg => ({ ...pkg, price: Number(pkg.price) })) });
        assert.deepEqual(actual, planned.config, 'Exact catalog and settings readback');
        assert.equal(body.packages.length, 4);
        assert.equal(body.metrics.length, 4);
        assert.equal(body.experiment.status, 'active');
        assert.equal(body.promotion_timing.hold_hours, 24);
        assert.deepEqual(body.promotion_timing.days, page.follow_up_best_time_days);
        assert.equal(typeof body.promotion_timing.waiting_response, 'number');
        assert.ok(body.packages.every(pkg => pkg.tag_id && pkg.options.length === 6));
        const filtered = await fetch(origin + '/api/pages/' + page.page_id + '/chatbot/pricing?duration=24', { headers, signal: AbortSignal.timeout(30000) });
        assert.equal(filtered.status, 200);
        assert.equal((await filtered.json()).duration_seconds, 24);
        if (!dashboardVerified) {
            const dashboard = await fetch(origin + '/dashboard/pricing', { headers, signal: AbortSignal.timeout(30000) });
            assert.equal(dashboard.status, 200);
            const html = await dashboard.text();
            const chunk = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]).find(src => src.includes('/app/dashboard/pricing/page-'));
            assert.ok(chunk, 'Pricing dashboard bundle exists');
            const bundle = await (await fetch(new URL(chunk, origin), { signal: AbortSignal.timeout(20000) })).text();
            for (const marker of ['Pricing packages', 'Load current + 3 approved catalogs', 'Starting duration', 'Results by starting package', 'One package for the first 24 hours', 'at least 24 hours apart']) {
                assert.ok(bundle.includes(marker), 'Dashboard includes ' + marker);
            }
            const unauthorized = await fetch(origin + '/api/pages/' + page.page_id + '/chatbot/pricing', { signal: AbortSignal.timeout(20000) });
            assert.equal(unauthorized.status, 401);
            const forbidden = await fetch(origin + '/api/pages/00000000-0000-4000-8000-000000000000/chatbot/pricing', { headers, signal: AbortSignal.timeout(20000) });
            assert.equal(forbidden.status, 403);
            dashboardVerified = true;
        }
        results.push({ page: page.name.trim(), enabled: page.enabled, followUpEnabled: page.follow_up_enabled,
            catalogs: 4, durationsPerCatalog: 6, mode: body.experiment.mode, apiVerified: true, durationFilterVerified: true,
            deliveredCustomers: body.metrics.reduce((sum, row) => sum + Number(row.exposed), 0) });
    }
    const permissions = (await db.query(`SELECT p.proname, has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated, has_function_privilege('service_role',p.oid,'EXECUTE') AS service
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
        ('reserve_chatbot_pricing_offer','get_chatbot_pricing_contact_catalog','create_chatbot_pricing_experiment','get_chatbot_pricing_analytics','schedule_chatbot_pricing_promotion')`)).rows;
    assert.equal(permissions.length, 5);
    assert.equal((await db.query("SELECT count(*)::int n FROM app_private.schema_migrations WHERE version='20261022_003'")).rows[0].n, 1);
    const reserveFunction = (await db.query("SELECT pg_get_functiondef('public.reserve_chatbot_pricing_offer(uuid,uuid,text,boolean,boolean,integer)'::regprocedure) body")).rows[0].body;
    assert.ok(reserveFunction.includes("assignment.first_exposed_at > now() - interval '24 hours'"));
    assert.ok(permissions.every(row => !row.anon && !row.authenticated && row.service));
    assert.equal((await db.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'chatbot_pricing_%' AND c.relkind='r' AND c.relrowsecurity")).rows[0].n, 5);
    await db.query('ROLLBACK');
    const cron = await fetch(origin + '/api/cron/chatbot', { signal: AbortSignal.timeout(15000) });
    assert.equal(cron.status, 401);
    const report = { at: new Date().toISOString(), passed: true, sha, deployment: { id: deployment.id, url: deployment.url, state: deployment.readyState },
        dashboard: origin + '/dashboard/pricing', pages: results, permissionsVerified: true, dashboardVerified,
        settingsPreserved: true, manualTestMessagesSent: 0, workerInvocations: 0, databaseWrites: 0 };
    await writeFile(new URL('../../data/pricing-production-verification-2026-10-22.json', import.meta.url), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
