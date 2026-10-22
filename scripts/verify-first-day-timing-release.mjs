// Read-only production checks plus empty signed callback probes. Never invokes
// the message worker or creates a client/test conversation.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { encode } from 'next-auth/jwt';

const origin = 'https://veochatbot.vercel.app';
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_6543 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
await db.connect();
try {
    const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
    const project = JSON.parse(await readFile(new URL('../.vercel/project.json', import.meta.url), 'utf8'));
    const auth = JSON.parse(await readFile(path.join(process.env.APPDATA, 'com.vercel.cli', 'Data', 'auth.json'), 'utf8'));
    const deploymentResponse = await fetch('https://api.vercel.com/v13/deployments/veochatbot.vercel.app?teamId=' + project.orgId,
        { headers: { Authorization: 'Bearer ' + auth.token }, signal: AbortSignal.timeout(20000) });
    const deployment = await deploymentResponse.json();
    assert.equal(deploymentResponse.status, 200);
    assert.equal(deployment.readyState, 'READY');
    const deployedCommit = deployment.gitSource?.sha || deployment.meta?.githubCommitSha;
    assert.equal(deployedCommit, expectedCommit, 'Production must serve the committed release');
    const pages = (await db.query(
        'SELECT c.*,p.id,p.name,u.user_id FROM pages p JOIN chatbot_configs c ON c.page_id=p.id JOIN LATERAL(SELECT user_id FROM user_pages WHERE page_id=p.id LIMIT 1)u ON true ORDER BY p.id'
    )).rows;
    assert.ok(pages.length > 0);
    const results = [];
    let bundleVerified = false;
    for (const page of pages) {
        const token = await encode({ secret: process.env.NEXTAUTH_SECRET,
            token: { id: page.user_id, name: 'First-day timing release verification' }, maxAge: 600 });
        const headers = { Cookie: '__Secure-next-auth.session-token=' + token };
        const response = await fetch(origin + '/api/pages/' + page.id + '/chatbot',
            { headers, signal: AbortSignal.timeout(25000) });
        const result = await response.json();
        assert.equal(response.status, 200, result.message || result.error);
        assert.equal(result.config.follow_up_first_day_mode, 'adaptive');
        assert.equal(result.config.enabled, page.enabled);
        assert.equal(result.config.follow_up_enabled, page.follow_up_enabled);
        assert.deepEqual(result.config.follow_up_best_time_days, page.follow_up_best_time_days);
        if (!bundleVerified && page.enabled) {
            const dashboard = await fetch(origin + '/dashboard/chatbot', { headers, signal: AbortSignal.timeout(25000) });
            assert.equal(dashboard.status, 200);
            const html = await dashboard.text();
            const chunk = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1])
                .find(src => src.includes('/app/dashboard/chatbot/page-'));
            assert.ok(chunk, 'Chatbot dashboard bundle');
            const bundleResponse = await fetch(new URL(chunk, origin), { signal: AbortSignal.timeout(20000) });
            assert.equal(bundleResponse.status, 200);
            const bundle = await bundleResponse.text();
            for (const marker of ['First-day timing', 'Adaptive timing for silent new clients', 'first 24 hours']) {
                assert.ok(bundle.includes(marker), 'Deployed bundle includes ' + marker);
            }
            bundleVerified = true;
        }
        results.push({ page: page.name.trim(), enabled: page.enabled, followUpEnabled: page.follow_up_enabled,
            timingMode: result.config.follow_up_first_day_mode, apiVerified: true });
    }
    if (pages.some(page => page.enabled)) assert.ok(bundleVerified);
    const handshake = new URL('/api/facebook/webhook', origin);
    handshake.searchParams.set('hub.mode', 'subscribe');
    handshake.searchParams.set('hub.verify_token', process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN);
    handshake.searchParams.set('hub.challenge', 'first-day-timing-release');
    const handshakeResponse = await fetch(handshake, { signal: AbortSignal.timeout(15000) });
    assert.equal(handshakeResponse.status, 200);
    assert.equal(await handshakeResponse.text(), 'first-day-timing-release');
    const payload = JSON.stringify({ object: 'page', entry: [] });
    const signature = 'sha256=' + createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(payload).digest('hex');
    const probe = await fetch(origin + '/api/facebook/webhook', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
        body: payload, signal: AbortSignal.timeout(15000)
    });
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).success, true);
    const cronGuard = await fetch(origin + '/api/cron/chatbot', { signal: AbortSignal.timeout(15000) });
    assert.equal(cronGuard.status, 401, 'Worker remains protected; no worker invoked');
    const migration = (await db.query("SELECT version FROM app_private.schema_migrations WHERE version='20261022_001'")).rows;
    assert.equal(migration.length, 1);
    const report = { at: new Date().toISOString(), passed: true, commit: expectedCommit,
        deployment: { id: deployment.id, url: deployment.url, readyState: deployment.readyState },
        productionOrigin: origin, pages: results, dashboardBundleVerified: bundleVerified,
        webhookVerified: true, workerAuthVerified: true, schemaVerified: true,
        databaseWrites: 0, testCustomerMessagesSent: 0, workerInvocations: 0 };
    await writeFile(new URL('../../data/first-day-timing-production-verification-2026-10-22.json', import.meta.url), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
} finally { await db.end(); }
