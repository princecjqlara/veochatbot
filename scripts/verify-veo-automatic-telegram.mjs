import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const origin = 'https://veochatbot.vercel.app';
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
db.on('error', () => {});
async function headers(id) { return { Cookie: `__Secure-next-auth.session-token=${await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 600, token: { id } })}` }; }
async function read(path, auth = {}) { const r = await fetch(origin + path, { headers: auth, redirect: 'error', signal: AbortSignal.timeout(60000) });return { status: r.status, body: await r.json() }; }
try {
    await db.connect();
    assert.equal((await db.query("SELECT count(*)::int n FROM app_private.schema_migrations WHERE version='202611080007'")).rows[0].n, 1);
    assert.equal((await db.query('SELECT launch_at FROM veo_tenants WHERE id=$1', [launch.id])).rows[0].launch_at.toISOString(), new Date(launch.launch_at).toISOString());
    for (const table of ['veo_telegram_link_codes', 'veo_telegram_auto_grants', 'veo_telegram_auto_states']) assert.equal((await db.query("SELECT has_table_privilege('anon',$1,'SELECT') OR has_table_privilege('authenticated',$1,'SELECT') exposed", [table])).rows[0].exposed, false);
    for (const fn of ['veo_create_telegram_link(uuid,text)', 'veo_confirm_telegram_link(uuid,text,bigint,bigint,text)', 'veo_apply_telegram_automation(uuid,jsonb)']) assert.equal((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') exposed", [fn])).rows[0].exposed, false);
    assert.equal((await read('/api/workspace/profile/telegram-link')).status, 401);
    const accounts = (await db.query('SELECT user_id,role FROM veo_accounts WHERE tenant_id=$1 AND active ORDER BY role,user_id', [launch.id])).rows;
    const checks = [];
    for (const account of accounts) {
        const auth = await headers(account.user_id);
        const profile = await read('/api/workspace/profile/telegram-link', auth);
        assert.equal(profile.status, 200);assert.equal(typeof profile.body.linked, 'boolean');
        const groups = await read('/api/workspace/telegram-groups', auth);
        assert.equal(groups.status, 200);assert.equal(groups.body.scope.user_id, account.user_id);
        assert(!/code_hash|password_hash|service_role_key/.test(JSON.stringify(groups.body)));
        checks.push({ role: account.role, linked: profile.body.linked, groups: groups.body.groups.length });
    }
    // Verify the maintained production hierarchy inside a rollback only.
    const leader = accounts.find(a => a.role === 'team_leader');
    if (leader) {
        await db.query('BEGIN');
        const member = randomUUID();
        await db.query("SELECT veo_action($1,'create_account',$2)", [launch.owner, JSON.stringify({ user_id: member, parent_id: leader.user_id, role: 'member', name: 'Rollback hierarchy check', email: member + '@example.invalid', password_hash: 'x'.repeat(40), page_ids: [] })]);
        const scope = (await db.query('SELECT veo_scope($1) s', [member])).rows[0].s;
        assert.equal(scope.role, 'member');assert.deepEqual(scope.page_ids, []);
        await db.query('ROLLBACK');
    }
    const automaticUrl = new URL('/api/veo/workspace', process.env.VEO_JAUCIAN_URL);
    automaticUrl.search = new URLSearchParams({ resource: 'automatic', tenant_id: launch.id, offset: '0', limit: '1' }).toString();
    const automatic = await fetch(automaticUrl, { headers: { Authorization: `Bearer ${process.env.VEO_JAUCIAN_SECRET}` }, redirect: 'error', signal: AbortSignal.timeout(60000) });
    assert.equal(automatic.status, 200);const snapshot = await automatic.json();assert.equal(snapshot.tenant_id, launch.id);assert(Array.isArray(snapshot.workers));
    const sync = (await db.query('SELECT auto_checked_at,auto_last_error,auto_cursor FROM veo_telegram_sync_state WHERE tenant_id=$1', [launch.id])).rows[0];
    const result = { verified_at: new Date().toISOString(), accounts: checks, direct_leader_members_verified: !!leader, launch_unchanged: true, private_permissions_verified: true,
        automatic_directory_groups: snapshot.groups.length, automatic_sync: sync, telegram_messages_sent: false };
    fs.writeFileSync('.vercel/automatic-telegram-live-verification.json', JSON.stringify(result, null, 2));console.log(JSON.stringify(result, null, 2));
} finally { await db.end().catch(() => {}); }
