// Add timestamp storage and repair only the single proven historical inquiry.
// Does not dispatch webhooks, send messages, enable bots, or reset retry/status data.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

const pageId = '776b33f3-e492-43bd-a887-d451d7faa5a8';
const historicalSecond = Date.parse('2026-10-17T19:01:47Z');
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_6543,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, query_timeout: 25000 });
const switches = async () => ({
    botsEnabled: (await db.query('SELECT count(*)::integer AS count FROM chatbot_configs WHERE enabled')).rows[0].count,
    recoveryEnabled: (await db.query('SELECT count(*)::integer AS count FROM chatbot_inbound_recovery_pages WHERE enabled')).rows[0].count
});
const requireAllOff = flags => { assert.equal(flags.botsEnabled, 0); assert.equal(flags.recoveryEnabled, 0); };

await db.connect();
try {
    requireAllOff(await switches());
    await db.query(await readFile(new URL('../supabase/migrations/202610180001_chatbot_reply_inbound_timestamp.sql', import.meta.url), 'utf8'));
    const column = (await db.query("SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='chatbot_reply_events' AND column_name='inbound_at'")).rows[0];
    assert.equal(column?.data_type, 'timestamp with time zone');
    assert.equal(column.is_nullable, 'YES');

    const candidates = (await db.query(`SELECT r.*,c.psid,c.last_inbound_at AS contact_last_inbound_at,p.fb_page_id,p.access_token
        FROM chatbot_reply_events r JOIN contacts c ON c.page_id=r.page_id AND c.id=r.contact_id
        JOIN pages p ON p.id=r.page_id WHERE r.page_id=$1 AND r.status='failed' AND r.outbound_message_id IS NULL
        AND c.last_inbound_at >= $2 AND c.last_inbound_at < $3`,
    [pageId, new Date(historicalSecond), new Date(historicalSecond + 1000)])).rows;
    assert.equal(candidates.length, 1, 'Only the known unanswered inquiry may be repaired');
    const candidate = candidates[0];
    const url = new URL(`https://graph.facebook.com/v24.0/${candidate.fb_page_id}/conversations`);
    url.searchParams.set('user_id', candidate.psid);
    url.searchParams.set('fields', 'id,messages.limit(100){id,from,created_time}');
    url.searchParams.set('limit', '2');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${candidate.access_token}` }, signal: AbortSignal.timeout(10000) });
    const history = await response.json();
    assert.ok(response.ok && !history.error, 'Messenger history must be available for matching the exact inbound ID');
    assert.equal(history.data?.length, 1, 'The customer must have exactly one matching conversation');
    const thread = history.data[0];
    assert.ok(!thread.messages?.paging?.next, 'Do not infer timestamps from incomplete message history');
    assert.equal(thread.messages?.data?.length, 1, 'Only a conversation with one customer message and no Page replies can be backfilled');
    const message = thread.messages.data[0];
    assert.equal(message.id, candidate.inbound_message_id);
    assert.equal(message.from?.id, candidate.psid);
    assert.equal(Math.floor(Date.parse(message.created_time) / 1000) * 1000, historicalSecond);
    assert.equal(Math.floor(candidate.contact_last_inbound_at.getTime() / 1000) * 1000, historicalSecond);

    await db.query('BEGIN');
    try {
        await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
        const configs = (await db.query('SELECT enabled FROM chatbot_configs FOR SHARE')).rows;
        const recovery = (await db.query('SELECT enabled FROM chatbot_inbound_recovery_pages FOR SHARE')).rows;
        assert.ok(configs.length && configs.every(row => !row.enabled));
        assert.ok(recovery.every(row => !row.enabled));
        const contact = (await db.query('SELECT last_inbound_at FROM contacts WHERE page_id=$1 AND id=$2 FOR UPDATE', [pageId, candidate.contact_id])).rows[0];
        assert.equal(contact.last_inbound_at.getTime(), candidate.contact_last_inbound_at.getTime(), 'A newer incoming message prevents historical backfill');
        const rows = (await db.query('SELECT inbound_message_id,inbound_at,status,outbound_message_id FROM chatbot_reply_events WHERE page_id=$1 AND contact_id=$2 FOR UPDATE', [pageId, candidate.contact_id])).rows;
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert.equal(row.inbound_message_id, message.id);
        assert.equal(row.status, 'failed');
        assert.equal(row.outbound_message_id, null);
        let repaired = 0;
        if (!row.inbound_at) {
            await writeFile(new URL(`../../data/inbound-timestamp-backup-${Date.now()}.json`, import.meta.url), JSON.stringify({
                at: new Date().toISOString(), pageId, contactId: candidate.contact_id, reply: row, contactLastInboundAt: contact.last_inbound_at
            }, null, 2), { flag: 'wx' });
            const updated = await db.query(`UPDATE chatbot_reply_events SET inbound_at=$1 WHERE page_id=$2 AND inbound_message_id=$3
                AND status='failed' AND outbound_message_id IS NULL AND inbound_at IS NULL RETURNING inbound_at`,
            [contact.last_inbound_at, pageId, message.id]);
            assert.equal(updated.rowCount, 1);
            assert.equal(updated.rows[0].inbound_at.getTime(), contact.last_inbound_at.getTime());
            repaired = updated.rowCount;
        } else assert.equal(row.inbound_at.getTime(), contact.last_inbound_at.getTime());
        await db.query('COMMIT');
        const flags = await switches();
        requireAllOff(flags);
        console.log(JSON.stringify({ schemaReady: true, historicalTimestampsRepaired: repaired, ...flags, customerMessagesSent: 0 }));
    } catch (error) { await db.query('ROLLBACK'); throw error; }
} finally { await db.end(); }
