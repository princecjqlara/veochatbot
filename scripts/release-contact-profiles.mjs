import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';

const apply = process.argv.includes('--apply');
if (!apply && !process.argv.includes('--preflight')) throw Error('Choose --preflight or --apply');
const migration = '202611020004_contact_profiles.sql', version = migration.split('_')[0];
const sql = fs.readFileSync(new URL('../supabase/migrations/' + migration, import.meta.url), 'utf8')
    .replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 120000 });
const receipt = { at: new Date().toISOString(), migration, applied: false, preflight: !apply };
try {
    await db.connect();
    const baseline = async () => (await db.query(`SELECT
        (SELECT count(*)::int FROM tags) AS tags,
        (SELECT count(*)::int FROM contact_tags) AS tag_assignments,
        (SELECT md5(string_agg(to_jsonb(c)::text,',' ORDER BY page_id)) FROM chatbot_configs c) AS configs`)).rows[0];
    await db.query('BEGIN');
    const before = await baseline();
    await db.query(sql);
    const after = await baseline();
    assert.deepEqual(after, before, 'Existing tags, assignments or bot settings changed');
    const tables = (await db.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1) AND c.relrowsecurity`, [[
        'contact_profile_jobs','contact_profile_messages','contact_profile_snapshots','contact_purchases','contact_verified_payments'
    ]])).rows[0].n;
    assert.equal(tables, 5);
    assert.equal((await db.query("SELECT has_function_privilege('anon','public.record_contact_verified_payment(uuid,uuid,uuid,uuid,uuid,text,bigint,text,timestamptz,text,text,text)','EXECUTE') AS allowed")).rows[0].allowed, false);
    const jobs = (await db.query('SELECT count(*)::int AS n FROM contact_profile_jobs')).rows[0].n;
    if (apply) {
        await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT(version) DO NOTHING', [version, 'Conversation profiles and staff-verified payment records']);
        await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO UPDATE SET name=EXCLUDED.name,statements=EXCLUDED.statements', [version, 'contact_profiles', [sql]]);
        await db.query('COMMIT'); receipt.applied = true;
    } else await db.query('ROLLBACK');
    Object.assign(receipt, { passed: true, new_tables_rls: tables, queued_profiles: jobs,
        tags_preserved: before.tags, assignments_preserved: before.tag_assignments,
        bot_configuration_preserved: true, messages_sent: 0 });
} catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    Object.assign(receipt, { passed: false, error: String(error.message).slice(0, 500) }); process.exitCode = 1;
} finally {
    await db.end();
    fs.writeFileSync(new URL('../.vercel/profile-schema-' + (apply ? 'apply' : 'preflight') + '.json', import.meta.url), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
}
