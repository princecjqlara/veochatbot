import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pg from 'pg';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const origin = 'https://veochatbot.vercel.app';
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
db.on('error', () => {});
async function session(id) {
    const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 600, token: { id } });
    return { Cookie: `__Secure-next-auth.session-token=${token}` };
}
async function read(path, headers = {}, options = {}) {
    return fetch(origin + path, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(90000) });
}
try {
    await db.connect();
    const state = (await db.query('SELECT launch_at FROM veo_tenants WHERE id=$1', [launch.id])).rows[0];
    assert.equal(state.launch_at.toISOString(), new Date(launch.launch_at).toISOString());
    assert.equal((await db.query("SELECT count(*)::int n FROM app_private.schema_migrations WHERE version IN('202611080003','202611080004','202611080005','202611080006')")).rows[0].n, 4);
    for (const table of ['veo_telegram_groups', 'veo_team_telegram_groups', 'veo_team_telegram_pages', 'veo_telegram_memberships', 'veo_telegram_group_states', 'veo_telegram_intake_requests', 'veo_telegram_intake_tokens'])
        assert.equal((await db.query("SELECT has_table_privilege('anon',$1,'SELECT') OR has_table_privilege('authenticated',$1,'SELECT') exposed", [table])).rows[0].exposed, false);
    for (const signature of ['veo_telegram_group_action(uuid,text,jsonb)', 'veo_sync_telegram_groups(uuid,jsonb)', 'veo_telegram_intake(uuid,bigint,bigint,text,jsonb)'])
        assert.equal((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') exposed", [signature])).rows[0].exposed, false);
    const accounts = (await db.query('SELECT user_id,role FROM veo_accounts WHERE tenant_id=$1 AND active ORDER BY role,user_id', [launch.id])).rows;
    assert.equal((await read('/api/workspace/telegram-groups')).status, 401);
    const before = (await db.query('SELECT count(*)::int grants FROM user_pages')).rows[0].grants;
    let fetched = false;
    if (process.argv.includes('--fetch')) {
        const response = await read('/api/workspace/telegram-groups', await session(launch.owner), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'refresh' }) });
        const data = await response.json();
        assert.equal(response.status, 200, data.error || 'Head bot discovery failed');
        assert.equal(data.saved.saved, true); fetched = true;
    }
    const checked = [];
    let catalog;
    for (const account of accounts) {
        const response = await read('/api/workspace/telegram-groups', await session(account.user_id));
        const data = await response.json();
        assert.equal(response.status, 200, data.error || 'Telegram setup unavailable');
        assert.equal(data.scope.user_id, account.user_id);
        assert.equal(data.scope.tenant_id, launch.id);
        assert.equal(data.can_manage, account.role !== 'member');
        const branch = new Set((await db.query('SELECT veo_descendants($1) id', [account.user_id])).rows.map(r => r.id));
        const permitted = new Set((await db.query('SELECT id FROM pages WHERE veo_can_page($1,id)', [account.user_id])).rows.map(r => r.id));
        assert(data.accounts.every(w => branch.has(w.user_id)));
        assert(data.teams.every(t => branch.has(t.manager_id)));
        assert(data.pages.every(p => permitted.has(p.id)));
        assert(data.routes.every(r => permitted.has(r.page_id)));
        assert(data.memberships.every(m => branch.has(m.user_id)));
        assert(!/password_hash|access_token|service_role_key|photo_url|object_path/.test(JSON.stringify(data)));
        if (account.role === 'owner') catalog = data;
        checked.push({ role: account.role, teams: data.teams.length, groups: data.groups.length });
    }
    assert.equal((await db.query('SELECT count(*)::int grants FROM user_pages')).rows[0].grants, before);
    assert.equal((await db.query("SELECT count(*)::int n FROM pages WHERE veo_enabled AND name ILIKE '%suno%'")).rows[0].n, 0);
    if (fetched) assert(catalog.groups.length > 0);
    const result = { verified_at: new Date().toISOString(), accounts_checked: checked, launch_unchanged: true, page_grants_unchanged: true,
        approved_groups: catalog.groups.map(g => ({ name: g.name, registered_pages: g.pages.length, active: g.active })),
        application_teams: catalog.teams.map(t => ({ name: t.name, configured_groups: catalog.links.filter(l => l.team_id === t.id).length })),
        metadata_refreshed: fetched, private_tables_verified: true, manual_telegram_dispatch: false };
    fs.writeFileSync('.vercel/telegram-groups-live-verification.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally { await db.end().catch(() => {}); }
