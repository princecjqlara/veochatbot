// Production readiness and admin previews only. No customer messages, form
// submissions for real contacts, ownership changes or settings updates.
import fs from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { parse } = require('../../node_modules/dotenv');
const { encode } = require('next-auth/jwt');
const local = parse(fs.readFileSync(new URL('../.env.local', import.meta.url)));
const productionFile = new URL('../../data/sales-assistant-production-2026-10-30.env', import.meta.url);
const production = fs.existsSync(productionFile) ? parse(fs.readFileSync(productionFile)) : local;
const base = process.env.VERIFY_BASE_URL || 'https://veochatbot.vercel.app';
const output = new URL('../../data/sales-assistant-release-2026-10-30/live-verification.json', import.meta.url);
const receipt = { at: new Date().toISOString(), base, passed: false, checks: [], customerMessagesSent: 0, contactWrites: 0, settingsWrites: 0 };
const db = new pg.Client({ connectionString: local.DATABASE_POOLER_URL_5432 || local.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 20000 });
function token(pageId, contactId) {
    const payload = Buffer.from(JSON.stringify({ pageId, contactId, expires: Date.now() + 600000 })).toString('base64url');
    return payload + '.' + createHmac('sha256', production.CHATBOT_FORM_SECRET || production.NEXTAUTH_SECRET).update(payload).digest('base64url');
}
async function call(path, options = {}) {
    const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(85000) });
    return { status: response.status, headers: response.headers, body: await response.json() };
}
try {
    await db.connect();
    const configs = (await db.query('SELECT * FROM chatbot_configs ORDER BY page_id')).rows;
    const config = configs.find(item => item.enabled && item.commercial_video_intake_enabled);
    assert(config, 'No existing enabled commercial Page for an admin preview');
    assert(config.sales_assistant_settings && typeof config.sales_assistant_settings === 'object', 'Sales migration missing');
    assert(config.sales_assistant_settings.pricing_enabled !== true, 'Default pricing OFF was not preserved');
    const owner = (await db.query('SELECT user_id FROM user_pages WHERE page_id=$1 LIMIT 1', [config.page_id])).rows[0];
    assert(owner, 'Existing authorized Page membership is required');
    const cookie = await encode({ token: { id: owner.user_id, name: 'Sales assistant release verification' }, secret: production.NEXTAUTH_SECRET, maxAge: 600 });
    const headers = { Cookie: '__Secure-next-auth.session-token=' + cookie, 'Content-Type': 'application/json' };
    const endpoint = '/api/pages/' + config.page_id + '/chatbot';
    const page = await fetch(base + '/sales-form', { signal: AbortSignal.timeout(30000) });
    assert.equal(page.status, 200, 'Customer form page failed');
    assert((await page.text()).includes('Your commercial video details'), 'Customer form markup missing');
    const invalid = await call('/api/sales-form?token=invalid');
    assert.equal(invalid.status, 401, 'Invalid form links must be rejected');
    assert(invalid.headers.get('cache-control')?.includes('no-store'), 'Customer form responses must not be cached');
    receipt.checks.push('Public form renders; invalid tokens rejected; private responses not cached');
    const fixtureContact = randomUUID();
    const fixturePath = '/api/sales-form?token=' + encodeURIComponent(token(config.page_id, fixtureContact));
    const absent = await call(fixturePath);
    assert.equal(absent.status, 404, 'Production signing key or new form route is incorrect');
    const absentPost = await call(fixturePath, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ details: {}, base: {}, event_key: 'release-fixture-' + randomUUID() }) });
    assert.equal(absentPost.status, 404, 'Signed form POST origin handling failed');
    receipt.checks.push('Production-signed form GET/POST reach contact validation without creating contacts');
    const existing = (await db.query('SELECT contact_id,collected_details,status,stop_reason FROM chatbot_contact_states WHERE page_id=$1 ORDER BY updated_at DESC LIMIT 1', [config.page_id])).rows[0];
    if (existing) {
        const form = await call('/api/sales-form?token=' + encodeURIComponent(token(config.page_id, existing.contact_id)));
        assert.equal(form.status, 200, 'Existing customer form could not reopen');
        assert.equal(form.body.fields.length, 6, 'Default optional form fields missing');
        for (const field of form.body.fields) if (existing.collected_details[field.label]) assert(form.body.details[field.label] === existing.collected_details[field.label], 'Saved answer was not prefilled');
        receipt.checks.push('Existing saved customer answers reopen in the six-field optional form');
    }
    const stored = await call(endpoint, { headers });
    assert.equal(stored.status, 200, 'Authorized admin configuration read failed');
    assert(stored.body.config.sales_assistant_settings, 'Admin API is missing sales settings');
    const draft = { ...stored.body.config, rag_enabled: false, sales_assistant_settings: { ...stored.body.config.sales_assistant_settings, pricing_enabled: false } };
    const greeting = await call(endpoint, { method: 'POST', headers, body: JSON.stringify({ message: 'Hello po', contact_name: 'Release Check', history: [], collected_details: {}, draft_config: draft }) });
    assert.equal(greeting.status, 200, 'New inquiry preview failed');
    assert(greeting.body.reply.includes('STEP 1:') && greeting.body.reply.includes('Optional quick form'), 'Introduction or optional form missing');
    assert(!/\p{Extended_Pictographic}/u.test(greeting.body.reply), 'Current no-emoji voice changed');
    receipt.checks.push('Live admin preview introduces process and optional form in the preserved voice');
    const history = [{ role: 'assistant', content: greeting.body.reply }];
    const pricing = await call(endpoint, { method: 'POST', headers, body: JSON.stringify({ message: 'Magkano po?', contact_name: 'Release Check', history,
        collected_details: {}, sales_progress: greeting.body.sales_progress, draft_config: draft }) });
    assert.equal(pricing.status, 200, 'Pricing OFF preview failed');
    assert(pricing.body.reply.includes('exact pricing') && !/(?:PHP|\u20b1)\s*\d|BUONG PRICE LIST/i.test(pricing.body.reply), 'Pricing OFF disclosure guard failed');
    assert(pricing.body.intake_action !== 'handoff', 'Pricing inquiry created a new handoff');
    receipt.checks.push('Live pricing OFF inquiry acknowledged without amounts or a new handoff');
    const details = { 'Business Name': 'Release Fixture Tea House', 'Business Industry': 'Restaurant', 'Product or Service': 'Milk Tea', 'Preferred Style': 'Realistic', 'Goal ng video': 'Dumami orders' };
    const complete = await call(endpoint, { method: 'POST', headers, body: JSON.stringify({ message: 'Ito na po ang details ko.', contact_name: 'Release Check', history,
        collected_details: details, sales_progress: greeting.body.sales_progress, draft_config: draft }) });
    assert.equal(complete.status, 200, 'Completed sales-form preview failed');
    assert(complete.body.collected_details['Business Name'] === details['Business Name'], 'Saved business name was lost');
    assert(!complete.body.reply.includes('STEP 1:') && !complete.body.reply.includes('Optional quick form') && !complete.body.reply.includes('Ano ang pangalan'), 'Completed form restarted intake');
    assert(/proceed|simulan/i.test(complete.body.reply), 'Completed form has no next sales action');
    receipt.checks.push('Completed sales details resume directly into the next sales action');
    const after = (await db.query('SELECT * FROM chatbot_configs ORDER BY page_id')).rows;
    assert.deepEqual(after, configs, 'Live preview changed persistent Page configuration');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM contacts WHERE id=$1', [fixtureContact])).rows[0].n, 0, 'Fixture contact was unexpectedly created');
    receipt.checks.push('Page configuration and enablement unchanged; no fixture lead created');
    receipt.enabledPageCount = after.filter(item => item.enabled).length;
    receipt.passed = true;
} catch (error) { receipt.error = String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted connection]'); process.exitCode = 1; }
finally { await db.end(); fs.mkdirSync(new URL('./', output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2)); }
