import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 15000 });
const schema = `reset_test_${randomUUID().replaceAll('-', '')}`;
const client = await pool.connect();
try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query(`CREATE SCHEMA ${schema}`);
    for (const table of ['contacts', 'chatbot_configs', 'chatbot_contact_states', 'chatbot_follow_up_jobs']) {
        await client.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await client.query(`CREATE TABLE ${schema}.schema_migrations(version text PRIMARY KEY,description text)`);
    const { rows: [contact] } = await client.query(`SELECT c.* FROM public.contacts c
        JOIN public.chatbot_contact_states s ON s.contact_id=c.id AND s.page_id=c.page_id
        WHERE c.last_inbound_at IS NOT NULL LIMIT 1`);
    assert.ok(contact, 'A representative existing contact is required');
    await client.query(`INSERT INTO ${schema}.contacts SELECT * FROM public.contacts WHERE id=$1`, [contact.id]);
    await client.query(`INSERT INTO ${schema}.chatbot_configs SELECT * FROM public.chatbot_configs WHERE page_id=$1`, [contact.page_id]);
    await client.query(`INSERT INTO ${schema}.chatbot_contact_states SELECT * FROM public.chatbot_contact_states WHERE contact_id=$1 AND page_id=$2`, [contact.id, contact.page_id]);
    const { rows: [original] } = await client.query(`SELECT * FROM ${schema}.chatbot_contact_states`);
    const migration = (await readFile(new URL('../supabase/migrations/202610170002_explicit_chatbot_reset.sql', import.meta.url), 'utf8'))
        .replace(/^BEGIN;\s*/m, '').replace(/COMMIT;\s*$/m, '')
        .replaceAll('public.', `${schema}.`).replaceAll('app_private.', `${schema}.`)
        .replaceAll('search_path=public,pg_temp', `search_path=${schema},pg_temp`);
    await client.query(migration);
    const { rows: [job] } = await client.query('SELECT * FROM public.chatbot_follow_up_jobs LIMIT 1');
    assert.ok(job, 'A representative queued job is required');
    job.id = randomUUID(); job.contact_id = contact.id; job.page_id = contact.page_id;
    job.status = 'pending'; job.anchor_inbound_at = contact.last_inbound_at;
    await client.query(`INSERT INTO ${schema}.chatbot_follow_up_jobs
        SELECT (jsonb_populate_record(NULL::${schema}.chatbot_follow_up_jobs,$1::jsonb)).*`, [JSON.stringify(job)]);
    // No wrong-Page reset may touch state or the pending sequence.
    await client.query('SAVEPOINT wrong_page');
    await assert.rejects(client.query(`SELECT ${schema}.reset_chatbot_contact($1,$2)`, [randomUUID(), contact.id]), /not found/);
    await client.query('ROLLBACK TO SAVEPOINT wrong_page');
    assert.equal((await client.query(`SELECT status FROM ${schema}.chatbot_follow_up_jobs`)).rows[0].status, 'pending');
    await client.query(`SELECT ${schema}.reset_chatbot_contact($1,$2)`, [contact.page_id, contact.id]);
    const { rows: [state] } = await client.query(`SELECT * FROM ${schema}.chatbot_contact_states`);
    assert.equal(state.status, 'active'); assert.equal(state.stop_reason, null); assert.equal(state.pause_kind, null);
    assert.notEqual(state.id, original.id); assert.equal(state.automation_epoch, (original.automation_epoch || 0) + 1);
    assert.deepEqual(state.collected_details, {}); assert.equal(state.has_clear_request, false);
    assert.equal(+state.last_inbound_at, +contact.last_inbound_at);
    assert.equal(+state.window_expires_at, +contact.last_inbound_at + 7 * 86400000);
    assert.equal(+state.messenger_history_reset_at, +state.automation_resumed_at);
    assert.equal((await client.query(`SELECT status FROM ${schema}.chatbot_follow_up_jobs`)).rows[0].status, 'cancelled');
    const { rows: [updated] } = await client.query(`SELECT * FROM ${schema}.contacts`);
    assert.equal(updated.pipeline_stage, 'engaged'); assert.equal(updated.pipeline_stage_source, 'system');
    assert.equal(+updated.last_inbound_at, +contact.last_inbound_at);
    for (const role of ['anon', 'authenticated']) {
        assert.equal((await client.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',
            [role, `${schema}.reset_chatbot_contact(uuid,uuid)`])).rows[0].allowed, false);
    }
    console.log('Reset SQL checks passed: scoped authorization, atomic state/job/pipeline reset, epoch, permission anchor, and RPC privileges.');
} finally {
    await client.query('ROLLBACK');
    client.release(); await pool.end();
}
