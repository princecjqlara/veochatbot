// Fetch real available Facebook metadata and verify a deliberately incomplete
// Done submission is rejected before storage. Never creates a synthetic sale,
// changes a lead manually, dispatches Telegram or calls a delivery worker.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { assertProjectCredentials, VEO_TARGET_PROJECT } from './lib/database-migration-safety.mjs';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const launch = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const { connectionString } = assertProjectCredentials(process.env, VEO_TARGET_PROJECT);
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
const origin = 'https://veochatbot.vercel.app', requestId = randomUUID();
const result = { at: new Date().toISOString(), passed: false, checks: {}, manual_deliveries: 0 };
async function counts() {
    return (await db.query(`SELECT (SELECT count(*)::int FROM veo_receipts) receipts,(SELECT count(*)::int FROM veo_photo_objects) photos,
    (SELECT count(*)::int FROM veo_orders) orders,(SELECT count(*)::int FROM veo_payments) payments,(SELECT count(*)::int FROM contact_verified_payments) retained_payments,
    (SELECT launch_at FROM veo_tenants WHERE id=$1) launch`, [launch.id])).rows[0];
}
try {
    await db.connect(); const before = await counts();
    const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 300, token: { id: launch.owner } });
    const headers = { Cookie: '__Secure-next-auth.session-token=' + token, Origin: origin };
    const client = (await db.query(`SELECT c.id contact_id,a.user_id seller_id FROM contacts c JOIN veo_accounts a ON a.tenant_id=$1 AND a.active AND a.role IN('member','manager')
    WHERE veo_can_page($2,c.page_id) AND veo_can_page(a.user_id,c.page_id) ORDER BY c.last_interaction_at DESC NULLS LAST,c.id,a.user_id LIMIT 1`, [launch.id, launch.owner])).rows[0];
    assert(client, 'An active selling worker and accessible client are required');
    const checkResponse = await fetch(origin + '/api/workspace/receipts', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'check', ...client, receipt_kind: 'done' }), signal: AbortSignal.timeout(65000) });
    const check = await checkResponse.json(); assert.equal(checkResponse.status, 200, check.error);
    assert.equal(check.allowed, false); assert(check.blockers.includes('create_and_link_order'));
    assert(check.facebook.checked_at); assert(!JSON.stringify(check).includes('access_token'));
    result.checks.live_facebook_check = { status: checkResponse.status, allowed: check.allowed, blockers: check.blockers, stage_available: !!check.facebook.stage, complete: check.facebook.complete, checked_at: check.facebook.checked_at, provider_error: !!check.facebook.error };
    const form = new FormData();
    for (const [k, v] of Object.entries({ ...client, request_id: requestId, receipt_kind: 'done', deal_mode: 'new' })) form.set(k, v);
    form.set('photo', new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }), 'blocked-verification.jpg');
    const submitted = await fetch(origin + '/api/workspace/receipts', { method: 'POST', headers, body: form, signal: AbortSignal.timeout(65000) });
    const rejected = await submitted.json(); assert.equal(submitted.status, 422, rejected.error); assert(rejected.requirements.blockers.includes('create_and_link_order'));
    assert.equal((await db.query('SELECT count(*)::int n FROM veo_receipts WHERE request_id=$1', [requestId])).rows[0].n, 0);
    result.checks.incomplete_submit = { status: submitted.status, saved: false, before_storage: true, blockers: rejected.requirements.blockers };
    const after = await counts(); assert.deepEqual(after, before); assert.equal(after.launch.getTime(), Date.parse(launch.launch_at));
    result.checks.records_and_launch_unchanged = true;
    const exposed = (await db.query(`SELECT count(*)::int n FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_record_facebook_check','veo_facebook_check_context','veo_receipt_requirements','veo_submission_facebook_context','veo_receipt_save','veo_receipt_recheck','veo_handoff')
    AND(has_function_privilege('anon',oid,'EXECUTE') OR has_function_privilege('authenticated',oid,'EXECUTE'))`)).rows[0].n;
    assert.equal(exposed, 0); result.checks.private_functions = true;
    result.checks.telegram_mapping_gaps = (await db.query(`SELECT (SELECT count(*)::int FROM veo_teams WHERE tenant_id=$1 AND telegram_chat_id IS NULL) teams,
    (SELECT count(*)::int FROM veo_accounts a LEFT JOIN veo_worker_mappings m ON m.user_id=a.user_id WHERE a.tenant_id=$1 AND a.active AND a.role IN('member','manager') AND m.user_id IS NULL) sellers`, [launch.id])).rows[0];
    result.passed = true;
} catch (e) { result.error = e.message; process.exitCode = 1; }
finally { await db.end(); fs.writeFileSync('.vercel/facebook-receipt-gate-production-verification.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }
