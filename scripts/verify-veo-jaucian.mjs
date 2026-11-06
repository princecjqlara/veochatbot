import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRequire } from 'node:module';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const receipt = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
const origin = 'https://veochatbot.vercel.app', bot = 'https://jaucianassitant.vercel.app';
async function read(url, headers = {}) {
    return fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(60000) });
}
async function session(id) {
    const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 300, token: { id } });
    return { Cookie: `__Secure-next-auth.session-token=${token}; next-auth.session-token=${token}` };
}
try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    const scope = (await db.query('SELECT veo_scope($1) AS value', [receipt.owner])).rows[0].value;
    assert.equal(scope.role, 'owner'); assert.equal(scope.tenant_id, receipt.id);
    const member = (await db.query("SELECT user_id FROM veo_accounts WHERE tenant_id=$1 AND active AND role<>'owner' ORDER BY CASE role WHEN 'member' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END LIMIT 1", [receipt.id])).rows[0];
    await db.query('COMMIT');
    assert.equal((await read(origin + '/api/workspace/jaucian')).status, 401);
    assert.equal((await read(origin + '/api/workspace/handoff?resource=directory&tenant_id=' + receipt.id)).status, 401);
    assert.equal((await read(bot + '/api/veo/workspace?tenant_id=' + receipt.id)).status, 401);
    if (member) assert.equal((await read(origin + '/api/workspace/jaucian', await session(member.user_id))).status, 403);
    const response = await read(origin + '/api/workspace/jaucian', await session(receipt.owner));
    const data = await response.json();
    assert.equal(response.status, 200, data.error || 'Owner connection check failed');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(data.workspace.tenant_id, receipt.id); assert.equal(data.jaucian.tenant_id, receipt.id);
    assert.equal(data.jaucian.veo_connection.ok, true, 'Jaucian must authenticate back to VEO');
    for (const rule of [data.workspace.commission_rule, data.jaucian.veo_connection.commission_rule]) {
        assert.equal(rule.qualified_rate, 40); assert.equal(rule.default_rate, 35); assert.equal(rule.team_override, false);
        assert.equal(rule.qualification, 'both_personal_closed_and_done_targets');
    }
    assert(data.jaucian.groups.length > 0);
    assert(data.jaucian.groups.every(g => /^veo\b/i.test(g.name) && g.chat_id < 0 && g.identity_coverage.complete_member_list === false));
    assert(!/password_hash|access_token|service_role_key|photo_url|object_path/i.test(JSON.stringify(data)));
    const health = await read(bot + '/api/health'); assert.equal(health.status, 200);
    const workers = data.workspace.accounts.filter(a => ['member', 'manager'].includes(a.role));
    const groups = new Set(data.jaucian.groups.map(g => String(g.chat_id)));
    const result = { verified_at: new Date().toISOString(), both_services_authenticated: true,
        owner_only_directory_verified: true, anonymous_access_rejected: true, commission_policy: data.workspace.commission_rule,
        workspace_accounts: data.workspace.accounts.length, teams: data.workspace.teams.length,
        approved_veo_groups: data.jaucian.groups.length,
        observed_identities: data.jaucian.groups.reduce((n, g) => n + g.identities.length, 0),
        unmapped_teams: data.workspace.teams.filter(t => !groups.has(String(t.telegram_chat_id))).length,
        unmapped_workers: workers.filter(w => !w.telegram_user_id).length,
        recent_deliveries: data.jaucian.recent_deliveries.length, jaucian_healthy: true,
        production_mutations: false, manual_telegram_dispatch: false };
    fs.writeFileSync('.vercel/jaucian-connection-verification.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally { await db.end(); }
