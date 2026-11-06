// Production checks never send customer/Telegram messages or change payments.
// --analyze queues one existing contact's saved-source demographic extraction.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRequire } from 'node:module';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, query_timeout: 30000, connectionTimeoutMillis: 15000 });
const report = { checked_at: new Date().toISOString(), passed: false, page_checks: [], profile: {}, tags: {}, demographics: {}, errors: [] };
const origin = 'https://veochatbot.vercel.app';
async function request(path, headers, body) { const r = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { ...headers, ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(115000) }); const b = await r.json(); return { status: r.status, body: b }; }
try {
    await db.connect();
    const scope = (await db.query('SELECT veo_scope($1) s', [launch.owner])).rows[0].s; assert.equal(scope.role, 'owner');
    const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 600, token: { id: launch.owner } }), headers = { Cookie: '__Secure-next-auth.session-token=' + token };
    const pages = (await db.query('SELECT p.id,count(c.id)::int contacts FROM pages p LEFT JOIN contacts c ON c.page_id=p.id WHERE p.id=ANY($1::uuid[]) GROUP BY p.id', [scope.page_ids])).rows;
    const contact = (await db.query(`WITH candidates AS MATERIALIZED(SELECT id,page_id,last_interaction_at FROM contacts WHERE page_id=ANY($1::uuid[]) ORDER BY last_interaction_at DESC NULLS LAST LIMIT 500) SELECT c.id,c.page_id FROM candidates c JOIN contact_profile_snapshots s ON s.contact_id=c.id AND s.page_id=c.page_id
        WHERE c.page_id=ANY($1::uuid[]) AND jsonb_typeof(s.payload->'extracted_answers')='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.payload->'extracted_answers') a WHERE lower(a->>'field') IN('business location','city','industry','age') AND length(a->>'value')>2)
        ORDER BY c.last_interaction_at ASC NULLS LAST,c.id LIMIT 1`, [scope.page_ids])).rows[0]; assert(contact, 'A retained source-bearing contact is needed');
    let cursor = 0; await Promise.all(Array.from({ length: 3 }, async () => { while (cursor < pages.length) { const p = pages[cursor++], r = await request(`/api/pages/${p.id}/contacts?page=1&pageSize=1`, headers); assert.equal(r.status, 200); assert(Array.isArray(r.body.items)); assert(r.body.total >= p.contacts); report.page_checks.push({ page_id: p.id, contacts: r.body.total, head_access: true }); } }));
    const profile = await request(`/api/pages/${contact.page_id}/contacts/${contact.id}/profile`, headers); assert.equal(profile.status, 200); assert(Array.isArray(profile.body.contact.tags)); report.profile = { head_access: true, assigned_tags: profile.body.contact.tags.length, finance_history_available: Boolean(profile.body.finance) };
    const tags = await request('/api/tags?scope=all&pageSize=1000', headers); assert.equal(tags.status, 200); assert(tags.body.items.every(t => scope.page_ids.includes(t.page_id))); report.tags = { scoped_count: tags.body.total, no_disabled_pages: true };
    const demographics = await request('/api/workspace/demographics?contact_id=' + contact.id, headers); assert.equal(demographics.status, 200); assert.equal(demographics.body.fields.length, 12); report.demographics = { contact_id: contact.id, page_id: contact.page_id, accessible: true, fields: 12 };
    assert.equal((await request('/api/workspace/demographics?contact_id=' + contact.id)).status, 401);
    const foreign = (await db.query('SELECT id FROM contacts WHERE NOT(page_id=ANY($1::uuid[])) LIMIT 1', [scope.page_ids])).rows[0]; if (foreign) assert.equal((await request('/api/workspace/demographics?contact_id=' + foreign.id, headers)).status, 403);
    if (process.argv.includes('--analyze')) { const queued = await request('/api/workspace/demographics', headers, { contact_id: contact.id, action: 'refresh' }); assert.equal(queued.status, 202); report.demographics.ai_review_queued = true; }
    const privacy = (await db.query("SELECT has_table_privilege('anon','veo_contact_demographics','SELECT') OR has_function_privilege('authenticated','veo_demographic_action(uuid,uuid,text,jsonb)','EXECUTE') AS exposed")).rows[0]; assert.equal(privacy.exposed, false);
    report.passed = true;
} catch (e) { report.errors.push(e.message); process.exitCode = 1; }
finally { await db.end(); fs.writeFileSync('.vercel/veo-contact-verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, demographics: { ...report.demographics, contact_id: undefined, page_id: undefined } }, null, 2)); }
