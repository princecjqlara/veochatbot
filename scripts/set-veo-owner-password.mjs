import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hash, compare } from 'bcryptjs';
import pg from 'pg';
import { createInterface } from 'node:readline';

// Credentials arrive over non-echoing stdin, never command arguments or files.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
process.stdout.write('READY_FOR_OWNER_CREDENTIALS\n');
let db;
try {
    const line = await new Promise(resolve => input.once('line', resolve)); input.close();
    const credentials = JSON.parse(line);
    const email = String(credentials.email || '').trim().toLowerCase(), password = credentials.password;
    assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)); assert(typeof password === 'string' && password.length > 0);
    const receipt = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
    assert(fs.readFileSync('src/config/veo-owner.ts', 'utf8').includes(receipt.owner));
    assert.equal(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname, 'vhtbmdizugnxkgocmruq.supabase.co');
    const prehash = createHash('sha256').update(password, 'utf8').digest('base64');
    const passwordHash = 'veo-sha256:' + await hash(prehash, 12);
    credentials.password = undefined;
    db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
    await db.connect(); await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(76110601)');
    const owner = (await db.query(`SELECT u.id,u.email FROM users u JOIN veo_accounts a ON a.user_id=u.id
      JOIN veo_tenants t ON t.id=a.tenant_id WHERE u.id=$1 AND a.role='owner' AND a.active AND u.is_active
      AND t.owner_id=u.id AND t.id=$2 FOR UPDATE OF u`, [receipt.owner, receipt.id])).rows[0];
    assert(owner, 'Retained active Owner identity required');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users WHERE lower(email)=$1 AND id<>$2', [email, owner.id])).rows[0].n, 0, 'Email belongs to a different identity');
    const before = (await db.query('SELECT count(*)::int AS n FROM user_pages WHERE user_id=$1', [owner.id])).rows[0].n;
    await db.query('UPDATE users SET email=$1,password_hash=$2 WHERE id=$3', [email, passwordHash, owner.id]);
    await db.query('DELETE FROM veo_login_limits WHERE key=$1', [createHash('sha256').update(email).digest('hex')]);
    await db.query(`INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason)
      VALUES($1,$2,'owner_email_password',$2,$3,$4,'Owner requested email/password sign-in')`,
      [receipt.id, owner.id, JSON.stringify({ email: owner.email }), JSON.stringify({ email, password_changed: true })]);
    const saved = (await db.query('SELECT id,email,password_hash FROM users WHERE id=$1', [owner.id])).rows[0];
    assert.equal(saved.id, receipt.owner); assert.equal(saved.email, email);
    assert(await compare(prehash, saved.password_hash.slice(11)));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM user_pages WHERE user_id=$1', [owner.id])).rows[0].n, before);
    await db.query('COMMIT');
    console.log(JSON.stringify({ updated: true, owner_identity_preserved: true, password_verified: true, pages_preserved: before }));
} catch {
    await db?.query('ROLLBACK').catch(() => {});
    console.error('Owner credential update failed; no changes committed.'); process.exitCode = 1;
} finally { input.close(); if (process.stdin.isTTY) process.stdin.setRawMode(false); await db?.end(); }
