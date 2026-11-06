import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRequire } from 'node:module';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const receipt = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
const result = { verified_at: new Date().toISOString(), tenant_id: receipt.id, cutoff: receipt.launch_at };
try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    const scope = (await db.query('SELECT veo_scope($1) AS value', [receipt.owner])).rows[0].value;
    assert.equal(scope.role, 'owner'); assert.equal(scope.tenant_id, receipt.id); assert.equal(scope.page_ids.length, receipt.pages.length);
    assert(fs.readFileSync('src/config/veo-owner.ts', 'utf8').includes(receipt.owner), 'Owner credential maintenance must retain the CJ Lara identity');
    const ownerCredentials = (await db.query(`SELECT u.is_active AND a.active AND a.role='owner' AND t.owner_id=u.id
      AND u.password_hash LIKE 'veo-sha256:%' AS credentials_ready
      FROM users u JOIN veo_accounts a ON a.user_id=u.id JOIN veo_tenants t ON t.id=a.tenant_id WHERE u.id=$1`, [receipt.owner])).rows[0];
    assert.equal(ownerCredentials?.credentials_ready, true, 'CJ must have a hashed email/password credential');
    result.cj_owner_email_credentials_ready = true;
    const pages = (await db.query('SELECT id,name,fb_page_id FROM pages WHERE veo_enabled')).rows;
    const approved = JSON.parse(fs.readFileSync('src/config/veo-pages.json', 'utf8'));
    assert(pages.every(p => approved.some(a => a.facebook_page_id ? a.facebook_page_id === p.fb_page_id : a.name.trim().toLowerCase() === p.name.trim().toLowerCase())));
    const archive = (await db.query('SELECT source_table,count(*)::int AS n FROM veo_archive_records WHERE tenant_id=$1 GROUP BY source_table', [receipt.id])).rows;
    assert(archive.some(row => row.source_table === 'contacts' && row.n > 0));
    const financialArchive = archive.find(row => row.source_table === 'contact_verified_payments');
    assert.equal(financialArchive?.n, 658);
    const stopped = (await db.query(`SELECT
      (SELECT count(*)::int FROM campaigns WHERE created_at<$1 AND (status IN('draft','scheduled','sending') OR loop_status='active')) AS campaigns,
      (SELECT count(*)::int FROM workflow_automations WHERE created_at<$1 AND enabled) AS follow_ups,
      (SELECT count(*)::int FROM conversation_export_jobs WHERE created_at<$1 AND status IN('queued','running')) AS exports`, [receipt.launch_at])).rows[0];
    assert.deepEqual(stopped, { campaigns: 0, follow_ups: 0, exports: 0 });
    const events = (await db.query('SELECT status,count(*)::int AS n FROM veo_event_inbox GROUP BY status')).rows;
    const storage = (await db.query("SELECT public FROM storage.buckets WHERE id='veo-conversation-submissions'")).rows[0];
    assert.equal(storage.public, false);
    await db.query('COMMIT');
    Object.assign(result, { owner_preserved: true, veo_pages: pages.length, archives: archive, legacy_jobs_stopped: stopped, events, private_photos: true });
    const origin = 'https://veochatbot.vercel.app';
    const home = await fetch(origin, { signal: AbortSignal.timeout(20000) });
    assert.equal(home.status, 200);
    let html = await home.text();
    const clientScripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]).filter(p => p.includes('/app/page-'));
    for (const script of clientScripts) html += await (await fetch(new URL(script, origin), { signal: AbortSignal.timeout(20000) })).text();
    for (const role of ['Member', 'Manager', 'Team Leader', 'Owner']) assert(html.includes(role));
    assert(html.includes('All accounts use email and password'));
    assert(!html.includes('Continue with Facebook'));
    const providers = await (await fetch(origin + '/api/auth/providers')).json();
    assert.deepEqual(Object.keys(providers), ['credentials']);
    assert.equal((await fetch(origin + '/api/facebook/pages')).status, 410);
    result.facebook_login_and_connection_setup_removed = true;
    const api = await fetch(origin + '/api/workspace', { signal: AbortSignal.timeout(20000) });
    assert.equal(api.status, 401);
    const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 300, token: { id: receipt.owner, name: 'Cj Lara' } });
    for (const id of [receipt.owner, '00000000-0000-4000-8000-000000000099']) {
        const deniedToken = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 300, token: { id, facebookId: 'verification-only-facebook-session' } });
        const deniedFacebook = await fetch(origin + '/api/workspace', { headers: { Cookie: `__Secure-next-auth.session-token=${deniedToken}; next-auth.session-token=${deniedToken}` }, signal: AbortSignal.timeout(20000) });
        assert.equal(deniedFacebook.status, 401);
        assert((await deniedFacebook.json()).error.includes('Facebook sign-in has been removed'));
    }
    result.facebook_sessions_rejected_including_owner = true;
    const ownerResponse = await fetch(origin + '/api/workspace', { headers: { Cookie: `__Secure-next-auth.session-token=${token}; next-auth.session-token=${token}` }, signal: AbortSignal.timeout(30000) });
    const ownerBody = await ownerResponse.json();
    assert.equal(ownerResponse.status, 200);
    assert.equal(ownerBody.scope.role, 'owner'); assert.equal(ownerBody.scope.user_id, receipt.owner);
    assert(Array.isArray(ownerBody.capacity?.teams), 'Team capacity must be available to the Owner');
    assert.equal(typeof ownerBody.capacity.combined.capacity, 'number');
    assert.equal(typeof ownerBody.capacity.combined.quota.closed, 'number');
    assert.equal(typeof ownerBody.capacity.combined.tomorrow.capacity, 'number');
    result.team_capacity_verified = { teams: ownerBody.capacity.teams.length, full_capacity: ownerBody.capacity.combined.capacity,
        daily_quota: ownerBody.capacity.combined.quota.closed, tomorrow_quota: ownerBody.capacity.combined.tomorrow.capacity };
    assert.equal(typeof ownerBody.order_page?.total, 'number', 'Order lists must include full-ledger pagination');
    const headers = { Cookie: `__Secure-next-auth.session-token=${token}; next-auth.session-token=${token}` };
    const contactsResponse = await fetch(origin + '/api/workspace/contacts', { headers, signal: AbortSignal.timeout(30000) });
    const contactsBody = await contactsResponse.json();
    assert.equal(contactsResponse.status, 200);
    assert(contactsBody.total > 0 && contactsBody.items.length > 0, 'Retained clients must remain visible without new-period orders');
    assert(contactsBody.items.every(c => ownerBody.scope.page_ids.includes(c.page_id)), 'Search results must stay on assigned pages');
    const sample = contactsBody.items.find(c => c.psid || c.name);
    assert(sample, 'At least one searchable client must be available');
    const search = new URLSearchParams({ search: sample.psid || sample.name });
    const searchResponse = await fetch(origin + '/api/workspace/contacts?' + search, { headers, signal: AbortSignal.timeout(30000) });
    const searchBody = await searchResponse.json();
    assert.equal(searchResponse.status, 200); assert(searchBody.items.some(c => c.id === sample.id));
    const sessionResponse = await fetch(origin + '/api/auth/session', { headers, signal: AbortSignal.timeout(30000) });
    const sessionBody = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200); assert.equal(typeof sessionBody.user.telegramProfileConfirmed, 'boolean');
    result.contact_search = { verified: true, visible_contacts: contactsBody.total, returned_items: contactsBody.items.length, no_order_required: true, assigned_pages_only: true };
    result.telegram_profile_prompt_available = true;
    const pageResponse = await fetch(origin + '/api/pages?connectionDetails=1', { headers, signal: AbortSignal.timeout(30000) });
    const pageBody = await pageResponse.json();
    assert.equal(pageResponse.status, 200);
    assert(pageBody.pages.length > 0, 'At least one usable VEO page must be available');
    result.page_connections = { available: pageBody.pages.length, reconnect_required: pageBody.reconnectRequiredPages?.length || 0,
        verified_ready: pageBody.pages.filter(p => p.connectionStatus === 'ready').length };
    const tomorrow = new Date(Date.now() + 32 * 3600000).toISOString().slice(0, 10);
    const future = await fetch(origin + '/api/workspace?date=' + tomorrow, { headers: { Cookie: `__Secure-next-auth.session-token=${token}; next-auth.session-token=${token}` }, signal: AbortSignal.timeout(20000) });
    assert.equal(future.status, 400, 'Future targets cannot be frozen through the dashboard');
    const importRoute = await fetch(origin + '/api/pages/' + receipt.pages[0].id + '/sync', { method: 'POST', signal: AbortSignal.timeout(20000) });
    assert.equal(importRoute.status, 410);
    const handoff = await fetch('https://jaucianassitant.vercel.app/api/veo/handoff', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) });
    assert.equal(handoff.status, 401);
    if (process.env.VEO_JAUCIAN_SECRET) {
        const authenticated = await fetch('https://jaucianassitant.vercel.app/api/veo/handoff', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.VEO_JAUCIAN_SECRET}` }, signal: AbortSignal.timeout(20000) });
        assert.equal(authenticated.status, 409, 'The shared handoff key must authenticate before validating an empty payload');
        result.authenticated_handoff_verified_without_sending = true;
    }
    const suno = await fetch('https://jaucianassitant.vercel.app/api/suno/makata', { signal: AbortSignal.timeout(20000) });
    assert.equal(suno.status, 410);
    const health = await fetch('https://jaucianassitant.vercel.app/api/health', { signal: AbortSignal.timeout(20000) });
    const healthBody = await health.json();
    Object.assign(result, { sign_in_roles_shipped: true, owner_api_verified: true, future_target_freezing_blocked: true, suno_workflow_disabled: true, orders: ownerBody.orders.length, accounts: ownerBody.accounts.length, anonymous_access_rejected: true, historical_import_blocked: true,
        handoff_authentication_required: true, jaucian_health_status: health.status, jaucian_health: healthBody });
    assert.equal(health.status, 200);
    result.passed = true;
} catch (error) {
    result.passed = false; result.error = error.message; process.exitCode = 1;
} finally {
    await db.end();
    fs.writeFileSync('.vercel/workspace-production-verification.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}
