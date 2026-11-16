import fs from 'node:fs';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { assertProjectCredentials, assertSchemaDestination } from './lib/database-migration-safety.mjs';
import { migrationConnectionOptions } from './lib/migration-retry.mjs';

// Supabase's authenticator timeout also bounds PostgREST's schema discovery.
// Keep ordinary service-role queries on their existing deadline while allowing
// metadata discovery to finish. Application RPC deadlines remain independent.
const env = { ...parseEnv(fs.readFileSync('.env.local', 'utf8')), ...process.env };
const apply = process.argv.includes('--apply');
assert(apply !== process.argv.includes('--preflight'), 'Choose --preflight or --apply');
const project = assertSchemaDestination(new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]);
const endpoint = assertProjectCredentials(env, project);
const db = new pg.Client({ ...await migrationConnectionOptions(endpoint.connectionString), connectionTimeoutMillis: 10000, query_timeout: 20000 });
db.on('error', () => {});
const report = { at: new Date().toISOString(), project, mode: apply ? 'apply' : 'preflight' };
const roles = async () => (await db.query("SELECT rolname,rolconfig,rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolbypassrls FROM pg_roles WHERE rolname IN('authenticator','service_role') ORDER BY rolname")).rows;
const timeout = role => role.rolconfig?.find(setting => setting.startsWith('statement_timeout='))?.split('=')[1];
try {
    await db.connect();
    await db.query("BEGIN;SET LOCAL statement_timeout='15s';SET LOCAL lock_timeout='3s'");
    const before = await roles(), auth = before.find(r => r.rolname === 'authenticator'), service = before.find(r => r.rolname === 'service_role');
    assert(auth && service, 'Expected Data API roles');
    const previous = timeout(auth);
    assert(previous && /^(8s|30s)$/.test(previous), 'Review the existing authenticator deadline before changing it');
    if (!timeout(service)) await db.query("ALTER ROLE service_role SET statement_timeout='8s'");
    await db.query("ALTER ROLE authenticator SET statement_timeout='30s'");
    const after = await roles();
    for (const original of before) {
        const current = after.find(r => r.rolname === original.rolname);
        assert.deepEqual({ ...current, rolconfig: original.rolconfig }, original, 'Role permissions must stay unchanged');
        const unrelated = settings => (settings || []).filter(s => !s.startsWith('statement_timeout=')).sort();
        assert.deepEqual(unrelated(current.rolconfig), unrelated(original.rolconfig));
    }
    assert.equal(timeout(after.find(r => r.rolname === 'authenticator')), '30s');
    assert.equal(timeout(after.find(r => r.rolname === 'service_role')), timeout(service) || '8s');
    await db.query("NOTIFY pgrst,'reload config';NOTIFY pgrst,'reload schema'");
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
    Object.assign(report, { passed: true, schemaDiscoveryDeadline: '30s', serviceQueryDeadline: timeout(service) || '8s', permissionsPreserved: true });
} catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    Object.assign(report, { passed: false, error: error.message });
    process.exitCode = 1;
} finally {
    await db.end().catch(() => {});
    fs.mkdirSync('.vercel', { recursive: true });
    fs.writeFileSync('.vercel/schema-cache-repair-' + report.mode + '.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
