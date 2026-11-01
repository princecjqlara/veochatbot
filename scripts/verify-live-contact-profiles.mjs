import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const base = process.argv.find(value => value.startsWith('--base='))?.slice(7) || 'https://veochatbot.vercel.app';
const contactId = process.argv.find(value => value.startsWith('--contact='))?.slice(10) || null;
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const receipt = { at: new Date().toISOString(), base, checks: [], messages_sent: 0, financial_records_created: 0 };
try {
    await db.connect();
    const selected = (await db.query(`SELECT j.contact_id,j.page_id,up.user_id,p.name
        FROM contact_profile_jobs j JOIN pages p ON p.id=j.page_id JOIN user_pages up ON up.page_id=p.id
        WHERE p.messaging_auto_tag_last_error IS NULL AND ($1::uuid IS NULL OR j.contact_id=$1::uuid)
        ORDER BY (j.status='ready') DESC,(p.name='SAMA KANA MEDIA') DESC,j.requested_at DESC LIMIT 1`, [contactId])).rows[0];
    assert(selected, 'No authorized accessible profile job found');
    const contactPath = `/api/pages/${selected.page_id}/contacts/${selected.contact_id}/profile`;
    const call = async (url, options = {}) => {
        const cookie = await encode({ token: { id: selected.user_id, name: 'Contact profile release verification' }, secret: process.env.NEXTAUTH_SECRET, maxAge: 600 });
        const headers = { Cookie: (new URL(base).protocol === 'https:' ? '__Secure-next-auth.session-token=' : 'next-auth.session-token=') + cookie };
        const response = await fetch(base + url, { ...options, headers: { ...headers, ...options.headers }, cache: 'no-store', signal: AbortSignal.timeout(100000) });
        return { status: response.status, body: await response.json() };
    };
    assert.equal((await fetch(base + contactPath)).status, 401); receipt.checks.push('Unauthenticated profile denied');
    assert.equal((await call(contactPath + '/finance', { method: 'POST', headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    receipt.checks.push('Cross-origin financial changes denied before a write');
    assert.equal((await call(`/api/pages/${selected.page_id}/contacts/${randomUUID()}/profile`)).status, 404);
    receipt.checks.push('Unknown contact remains isolated');
    let profile;
    for (let pass = 0; pass < 32; pass++) {
        const response = await call(contactPath);
        assert.equal(response.status, 200, 'Profile sources failed to load');
        profile = response.body;
        if (profile.job.status === 'ready' || !process.argv.includes('--analyze')) break;
        assert.notEqual(profile.job.status, 'failed', 'Analysis failed: ' + profile.job.error_message);
        const refresh = await call(contactPath, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{"force":false}' });
        assert.equal(refresh.status, 202, 'Analysis request failed');
        (receipt.analysis_runs ||= []).push(refresh.body);
        console.log(JSON.stringify({ analysis_pass: pass + 1, ...refresh.body }));
        if (refresh.body.failed) {
            const failed = (await call(contactPath)).body;
            throw Error('Analysis failed: ' + failed.job.error_message);
        }
    }
    if (process.argv.includes('--analyze') && profile.job.status !== 'ready') profile = (await call(contactPath)).body;
    assert.equal(profile.contact.id, selected.contact_id);
    assert(!('access_token' in profile.page));
    assert.equal(profile.job.status, 'ready', 'Profile not ready: ' + (profile.job.error_message || profile.job.status));
    assert(profile.snapshot?.payload.history_complete);
    assert(profile.snapshot.payload.summary_points.length > 0);
    assert.equal(profile.snapshot.model, 'openai/gpt-6-luna');
    const messages = await call(contactPath + '/messages'); assert.equal(messages.status, 200);
    assert.equal(messages.body.total, profile.snapshot.message_count);
    const sourceId = profile.snapshot.payload.summary_points[0].evidence[0].message_id;
    const source = await call(contactPath + '/messages?messageId=' + encodeURIComponent(sourceId));
    assert.equal(source.body.items[0].message_id, sourceId);
    assert.equal(profile.finance.payments.length, 0); assert.equal(profile.finance.metrics.status, 'not_verified');
    const tags = await call('/api/tags?scope=all&pageId=' + selected.page_id + '&kind=history');
    assert.equal(tags.status, 200); assert(tags.body.items.every(tag => tag.system_key.startsWith('stage_history:')));
    assert(!('access_token' in profile.page));
    receipt.checks.push('Complete live conversation analyzed by GPT-6 Luna through OpenRouter',
        'Summary citations open their exact source messages', 'Missing financial records stay not verified', 'History category returns only automatic stage-history tags');
    Object.assign(receipt, { passed: true, contact_id: selected.contact_id, page_id: selected.page_id, page: selected.name,
        message_count: profile.snapshot.message_count, summary_points: profile.snapshot.payload.summary_points.length,
        supported_facts: profile.snapshot.payload.facts.length, required_answers_found: profile.snapshot.payload.extracted_answers?.length || 0,
        model: profile.snapshot.model, finance_status: profile.finance.metrics.status });
} catch (error) { Object.assign(receipt, { passed: false, error: String(error.message).slice(0, 500) }); process.exitCode = 1; }
finally {
    await db.end(); fs.writeFileSync(new URL('../.vercel/profile-live-' + (new URL(base).hostname === 'localhost' ? 'local' : 'production') + '.json', import.meta.url), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
}
