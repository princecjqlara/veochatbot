import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createInterface } from 'node:readline';

if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
const jar = new Map();
process.stdout.write('READY_FOR_OWNER_CREDENTIALS\n');
try {
    const credentials = JSON.parse(await new Promise(resolve => input.once('line', resolve))); input.close();
    const origin = process.env.VEO_VERIFY_ORIGIN || 'https://veochatbot.vercel.app';
    const receive = async (path, options = {}) => {
        const response = await fetch(new URL(path, origin), { ...options, redirect: 'manual', signal: AbortSignal.timeout(30000),
            headers: { ...options.headers, Cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; ') } });
        for (const header of response.headers.getSetCookie()) {
            const pair = header.split(';')[0], index = pair.indexOf('='); jar.set(pair.slice(0,index), pair.slice(index+1));
        }
        return response;
    };
    const csrfResponse = await receive('/api/auth/csrf'); assert.equal(csrfResponse.status, 200);
    const { csrfToken } = await csrfResponse.json(); assert(csrfToken);
    const response = await receive('/api/auth/callback/credentials', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
        body: new URLSearchParams({ csrfToken, email: credentials.email, password: credentials.password, role: 'owner', callbackUrl: origin + '/dashboard/workspace', json: 'true' }) });
    credentials.password = undefined;
    assert.equal(response.status, 200);
    const body = await response.json(); assert(!new URL(body.url, origin).searchParams.has('error'));
    const sessionResponse = await receive('/api/auth/session'); assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json(), receipt = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
    assert.equal(session.user.id, receipt.owner); assert.equal(session.user.role, 'owner');
    assert.equal(session.user.email.toLowerCase(), credentials.email.toLowerCase()); assert.equal(session.accessToken, undefined);
    const workspace = await receive('/api/workspace'); assert.equal(workspace.status, 200);
    const data = await workspace.json(); assert.equal(data.scope.user_id, receipt.owner);
    const result = { passed: true, authenticated_with_email_password: true, owner_identity_preserved: true,
        owner_role_verified: true, workspace_status: workspace.status, pages: data.scope.page_ids.length, facebook_token_not_exposed: true };
    fs.writeFileSync('.vercel/owner-credential-verification.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch {
    console.error('Owner credential verification failed; credentials and cookies have not been logged.'); process.exitCode = 1;
} finally { jar.clear(); input.close(); if (process.stdin.isTTY) process.stdin.setRawMode(false); }
