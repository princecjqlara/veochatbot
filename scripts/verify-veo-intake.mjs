import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRequire } from 'node:module';

const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const origin = 'https://veochatbot.vercel.app';
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
const samples = [];
const read = (path, headers = {}) => fetch(origin + path, { headers, redirect: 'error', signal: AbortSignal.timeout(60000) });
try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    const tenant = (await db.query('SELECT owner_id,launch_at FROM veo_tenants WHERE id=$1', [launch.id])).rows[0];
    assert.equal(tenant.owner_id, launch.owner);
    assert.equal(tenant.launch_at.toISOString(), new Date(launch.launch_at).toISOString());
    assert((await db.query("SELECT version FROM app_private.schema_migrations WHERE version='202611080001'")).rowCount);
    for (const signature of ['veo_intake_action(uuid,text,jsonb)', 'veo_intake_page(uuid,text,uuid,text,integer)'])
        assert.equal((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') exposed", [signature])).rows[0].exposed, false);
    const accounts = (await db.query('SELECT user_id,role,parent_id FROM veo_accounts WHERE tenant_id=$1 AND active ORDER BY role,user_id', [launch.id])).rows;
    const expectations = [];
    for (const actor of accounts) {
        const descendants = (await db.query('SELECT veo_descendants($1) id', [actor.user_id])).rows.map(r => r.id);
        const pages = (await db.query('SELECT id FROM pages WHERE veo_can_page($1,id)', [actor.user_id])).rows.map(r => r.id);
        const roster = accounts.filter(w => ['member', 'manager'].includes(w.role) && (descendants.includes(w.user_id) || actor.role === 'member' && (w.user_id === actor.parent_id || w.role === 'member' && w.parent_id === actor.parent_id))).map(w => w.user_id);
        const deniedPage = (await db.query('SELECT id FROM pages WHERE NOT veo_can_page($1,id) LIMIT 1', [actor.user_id])).rows[0]?.id;
        expectations.push({ ...actor, descendants, pages, roster, deniedPage });
    }
    await db.query('COMMIT');
    assert.equal((await read('/api/workspace/new-clients')).status, 401);
    for (const actor of expectations) {
        const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 600, token: { id: actor.user_id } });
        const headers = { Cookie: `__Secure-next-auth.session-token=${token}; next-auth.session-token=${token}` };
        const context = await read('/api/workspace/new-clients?context=1', headers);
        assert.equal(context.status, 200, 'Intake context failed');
        const current = await context.json();assert.equal(current.scope.user_id, actor.user_id);assert.equal(current.scope.tenant_id, launch.id);
        for (const view of ['pool', 'offers', 'assigned']) {
            const started = Date.now(), response = await read('/api/workspace/new-clients?view=' + view, headers);
            assert.equal(response.status, 200, 'Intake read failed with HTTP ' + response.status);
            const data = await response.json();
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.equal(data.role, actor.role);assert.equal(typeof data.readiness.ready, 'boolean');
            assert(Array.isArray(data.items) && Array.isArray(data.roster));
            for (const worker of data.roster) {
                assert(actor.roster.includes(worker.id), 'Roster crossed a branch boundary');
                assert(worker.page_ids.every(id => actor.pages.includes(id)), 'Roster leaked a Page');
            }
            for (const client of data.items) {
                assert(actor.pages.includes(client.page_id), 'Client crossed a Page boundary');
                if (view === 'assigned') assert(actor.descendants.includes(client.owner_id), 'Assignments crossed a branch boundary');
                if (view === 'offers') assert(actor.descendants.includes(client.offered_to), 'Offers crossed a branch boundary');
                if (view === 'pool') assert(!client.owner_id && !client.offer_id && !client.has_sales);
            }
            assert(!/password_hash|access_token|service_role_key|photo_url|object_path/.test(JSON.stringify(data)));
            samples.push({ role: actor.role, view, total: data.total, returned: data.items.length, milliseconds: Date.now() - started });
            if (view === 'pool' && data.items.length) {
                const filtered = await read('/api/workspace/new-clients?search=' + data.items[0].id, headers);
                const found = await filtered.json();assert.equal(filtered.status, 200);
                assert(found.items.some(c => c.id === data.items[0].id), 'Visible clients must be searchable');
            }
        }
        if (actor.deniedPage) assert.equal((await read('/api/workspace/new-clients?page_id=' + actor.deniedPage, headers)).status, 403);
    }
    const result = { verified_at: new Date().toISOString(), accounts_checked: accounts.length,
        roles_checked: [...new Set(accounts.map(a => a.role))], anonymous_access_rejected: true,
        branch_and_page_isolation_verified: true, client_search_verified: true, private_rpc_verified: true,
        launch_changed: false, production_mutations: false, samples };
    fs.writeFileSync('.vercel/new-client-intake-live-verification.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally { await db.end(); }
