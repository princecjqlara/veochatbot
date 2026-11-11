// This release applies only the staff performance reporting migration.
// It never applies unrelated drafts, creates an order or records payment, or sends a message.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { assertSchemaDestination, assertProjectCredentials, schemaMigrationPlan, migrationFingerprintMatches } from './lib/database-migration-safety.mjs';
import { migrationConnectionOptions } from './lib/migration-retry.mjs';

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--preflight') ? 'preflight' : null;
assert(mode && !(process.argv.includes('--apply') && process.argv.includes('--preflight')), 'Choose --preflight or --apply');
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
assertSchemaDestination(project);
const endpoint = assertProjectCredentials(process.env, project);
const migration = schemaMigrationPlan().find(item => item.name === '202611110001_veo_staff_performance.sql');
assert(migration, 'The reviewed staff performance migration is required');
const db = new pg.Client({ ...await migrationConnectionOptions(endpoint.connectionString), connectionTimeoutMillis: 10000, query_timeout: 45000 });
db.on('error', () => {});
const report = { at: new Date().toISOString(), mode, project, migration: migration.name, applied: false, messagesSent: 0, identitiesRelinked: 0 };
const inventory = async () => (await db.query(`SELECT
 (SELECT count(*)::int FROM users) AS users,
 (SELECT count(*)::int FROM veo_worker_mappings) AS telegram_mappings,
 (SELECT count(*)::int FROM veo_telegram_memberships) AS telegram_memberships,
 (SELECT count(*)::int FROM veo_salary_days) AS salary_days,
 (SELECT count(*)::int FROM veo_salary_adjustments) AS salary_adjustments,
 (SELECT count(*)::int FROM veo_accounts) AS accounts,
 (SELECT count(*)::int FROM pages) AS pages,
 (SELECT count(*)::int FROM user_pages) AS page_grants,
 (SELECT count(*)::int FROM contacts) AS contacts,
 (SELECT count(*)::int FROM tags) AS tags,
 (SELECT count(*)::int FROM contact_tags) AS contact_tags,
 (SELECT count(*)::int FROM veo_orders) AS orders,
 (SELECT count(*)::int FROM veo_payments) AS payments,
 (SELECT count(*)::int FROM veo_receipts) AS receipts,
 (SELECT count(*)::int FROM chatbot_configs) AS chatbot_configs,
 (SELECT jsonb_agg(jsonb_build_object('tenant',id,'launch_at',launch_at) ORDER BY id) FROM veo_tenants) AS cutoffs`)).rows[0];
try {
    await db.connect();
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    assert((await db.query("SELECT pg_try_advisory_xact_lock(hashtext('veobot_project_schema_install')) AS locked")).rows[0].locked, 'Another schema installer is running');
    const before = await inventory();
    const recorded = (await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations WHERE filename=$1', [migration.name])).rows[0];
    if (recorded) assert(migrationFingerprintMatches(recorded, migration, project), 'The installed staff performance migration fingerprint differs');
    else {
        await db.query(migration.sql);
        await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)', [migration.name, migration.sha256, project]);
        const tracking = (await db.query("SELECT to_regclass('app_private.schema_migrations') IS NOT NULL AS app,to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS supabase")).rows[0];
        if (tracking.app) await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT(version) DO NOTHING', ['202611110001', migration.name]);
        if (tracking.supabase) await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING', ['202611110001', migration.name.replace('.sql', ''), [migration.sql]]);
    }
    const privacy = (await db.query(`SELECT
      NOT has_function_privilege('anon','veo_employee_profile(uuid,uuid,date,date,uuid)','EXECUTE')
      AND NOT has_function_privilege('authenticated','veo_employee_profile(uuid,uuid,date,date,uuid)','EXECUTE')
      AND NOT has_table_privilege('anon','veo_telegram_pairing_codes','SELECT')
      AND NOT has_table_privilege('authenticated','veo_telegram_pairing_codes','SELECT') AS private`)).rows[0].private;
    assert.equal(privacy, true, 'Employee reports and pairing credentials must remain private');
    assert.deepEqual(await inventory(), before, 'Existing records and launch cutoffs must remain unchanged');
    await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    Object.assign(report, { passed: true, applied: mode === 'apply' && !recorded, alreadyInstalled: !!recorded, retained: before, privateFunctionsAndCredentials: true });
} catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    Object.assign(report, { passed: false, error: error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]') });
    process.exitCode = 1;
} finally {
    await db.end().catch(() => {});
    fs.mkdirSync('.vercel', { recursive: true });
    fs.writeFileSync(`.vercel/staff-performance-schema-${mode}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
