import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 15000 });
const schema = `recovery_test_${randomUUID().replaceAll('-', '')}`;
const client = await pool.connect();
try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.pages(id uuid PRIMARY KEY)`);
    await client.query(`CREATE TABLE ${schema}.chatbot_configs(page_id uuid PRIMARY KEY,enabled boolean NOT NULL)`);
    await client.query(`CREATE TABLE ${schema}.schema_migrations(version text PRIMARY KEY,description text)`);
    const migration = (await readFile(new URL('../supabase/migrations/202610170003_chatbot_inbound_recovery.sql', import.meta.url), 'utf8'))
        .replace(/^BEGIN;\s*/m, '').replace(/COMMIT;\s*$/m, '')
        .replaceAll('public.', `${schema}.`).replaceAll('app_private.', `${schema}.`)
        .replaceAll('search_path=public,pg_temp', `search_path=${schema},pg_temp`);
    await client.query(migration);
    const enabled = randomUUID(), optedOut = randomUUID(), disabled = randomUUID();
    for (const id of [enabled, optedOut, disabled]) {
        await client.query(`INSERT INTO ${schema}.pages VALUES($1)`, [id]);
        await client.query(`INSERT INTO ${schema}.chatbot_configs VALUES($1,$2)`, [id, id !== disabled]);
        await client.query(`INSERT INTO ${schema}.chatbot_inbound_recovery_pages(page_id,enabled) VALUES($1,$2)`, [id, id !== optedOut]);
    }
    const at = '2026-10-17T10:00:00Z';
    const claimed = await client.query(`SELECT * FROM ${schema}.claim_chatbot_inbound_recovery_pages(3,$1)`, [at]);
    assert.equal(claimed.rows.length, 1); assert.equal(claimed.rows[0].page_id, enabled);
    assert.equal((await client.query(`SELECT * FROM ${schema}.claim_chatbot_inbound_recovery_pages(3,$1)`, [at])).rows.length, 0);
    assert.equal((await client.query(`SELECT * FROM ${schema}.claim_chatbot_inbound_recovery_pages(3,$1)`, ['2026-10-17T10:04:00Z'])).rows.length, 1);
    for (const role of ['anon', 'authenticated']) {
        assert.equal((await client.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',
            [role, `${schema}.claim_chatbot_inbound_recovery_pages(integer,timestamp with time zone)`])).rows[0].allowed, false);
        assert.equal((await client.query('SELECT has_table_privilege($1,$2,\'SELECT\') AS allowed',
            [role, `${schema}.chatbot_inbound_recovery_pages`])).rows[0].allowed, false);
    }
    const enrollment = (await readFile(new URL('../supabase/migrations/202610170004_chatbot_recovery_enrollment.sql', import.meta.url), 'utf8'))
        .replace(/^BEGIN;\s*/m, '').replace(/COMMIT;\s*$/m, '')
        .replaceAll('public.', `${schema}.`).replaceAll('app_private.', `${schema}.`)
        .replaceAll('search_path=public,pg_temp', `search_path=${schema},pg_temp`);
    await client.query(enrollment);
    const future = randomUUID();
    await client.query(`INSERT INTO ${schema}.pages VALUES($1)`, [future]);
    await client.query(`INSERT INTO ${schema}.chatbot_configs VALUES($1,true)`, [future]);
    let recovery = (await client.query(`SELECT * FROM ${schema}.chatbot_inbound_recovery_pages WHERE page_id=$1`, [future])).rows[0];
    assert.equal(recovery.enabled, true);
    const activated = +recovery.enabled_at;
    await client.query(`UPDATE ${schema}.chatbot_inbound_recovery_pages SET enabled_at='2026-01-01',scan_cursor='old',lease_until=now()+interval '1 minute' WHERE page_id=$1`, [future]);
    await client.query(`UPDATE ${schema}.chatbot_configs SET enabled=false WHERE page_id=$1`, [future]);
    assert.equal((await client.query(`SELECT enabled FROM ${schema}.chatbot_inbound_recovery_pages WHERE page_id=$1`, [future])).rows[0].enabled, false);
    await client.query(`UPDATE ${schema}.chatbot_configs SET enabled=true WHERE page_id=$1`, [future]);
    recovery = (await client.query(`SELECT * FROM ${schema}.chatbot_inbound_recovery_pages WHERE page_id=$1`, [future])).rows[0];
    assert.equal(recovery.enabled, true); assert.ok(+recovery.enabled_at >= activated);
    assert.equal(recovery.scan_cursor, null); assert.equal(recovery.lease_until, null);
    console.log('Recovery SQL passed: explicit Page opt-in, enabled chatbot requirement, exclusive expiring lease, and service-only access. Scratch changes rolled back.');
    console.log('Automatic enrollment passed: newly enabled bot, disable, and fresh re-enable without historical replay.');
} finally {
    await client.query('ROLLBACK'); client.release(); await pool.end();
}
