// Exercise migration constraints in an isolated scratch schema, then roll back.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_6543 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
await db.connect();
try {
    await db.query('BEGIN');
    const schema = 'first_day_timing_verify_' + Date.now();
    await db.query('CREATE SCHEMA ' + schema);
    await db.query('CREATE TABLE ' + schema + ".chatbot_configs (page_id text PRIMARY KEY,enabled boolean NOT NULL DEFAULT false)");
    await db.query('CREATE TABLE ' + schema + ".chatbot_follow_up_jobs (id text PRIMARY KEY,purpose text NOT NULL DEFAULT 'scheduled',CONSTRAINT chatbot_follow_up_jobs_purpose_check CHECK(purpose IN ('scheduled','nightly_continuation')))");
    await db.query('CREATE TABLE ' + schema + '.schema_migrations(version text PRIMARY KEY,description text)');
    await db.query('INSERT INTO ' + schema + ".chatbot_configs(page_id,enabled) VALUES('page',true)");
    await db.query('INSERT INTO ' + schema + ".chatbot_follow_up_jobs(id) VALUES('existing')");
    const source = await readFile(new URL('../supabase/migrations/202610220001_chatbot_first_day_timing.sql', import.meta.url), 'utf8');
    const migration = source.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '')
        .replaceAll('public.', schema + '.').replaceAll('app_private.schema_migrations', schema + '.schema_migrations');
    await db.query(migration);
    await db.query(migration);
    const original = (await db.query('SELECT * FROM ' + schema + '.chatbot_configs')).rows[0];
    assert.equal(original.enabled, true);
    assert.equal(original.follow_up_first_day_mode, 'fixed');
    await db.query('UPDATE ' + schema + ".chatbot_configs SET follow_up_first_day_mode='adaptive'");
    await db.query('INSERT INTO ' + schema + ".chatbot_follow_up_jobs(id,purpose,timing_context) VALUES('adaptive','first_day_adaptive','{\"initial_reply_end\":\"2026-10-22T01:00:00Z\"}'::jsonb)");
    for (const statement of [
        'UPDATE ' + schema + ".chatbot_configs SET follow_up_first_day_mode='random'",
        'UPDATE ' + schema + ".chatbot_follow_up_jobs SET purpose='unknown' WHERE id='existing'"
    ]) {
        await db.query('SAVEPOINT invalid_value');
        let rejected = false;
        try { await db.query(statement); } catch (error) { rejected = error.code === '23514'; }
        await db.query('ROLLBACK TO SAVEPOINT invalid_value');
        assert.ok(rejected, 'Constraint must reject unsupported mode/purpose');
    }
    assert.equal((await db.query('SELECT count(*)::int AS n FROM ' + schema + '.chatbot_follow_up_jobs')).rows[0].n, 2);
    await db.query('ROLLBACK');
    console.log(JSON.stringify({ passed: true, idempotentMigration: true, existingRowsPreserved: true,
        invalidValuesRejected: true, temporarySchemaRolledBack: true, customerMessagesSent: 0 }));
} finally { await db.query('ROLLBACK').catch(() => {}); await db.end(); }
