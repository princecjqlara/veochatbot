// Read-only operational metadata; never prints SQL text or connection secrets.
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_6543,
    ssl: { rejectUnauthorized: false }, application_name: 'veobot-intake-audit', connectionTimeoutMillis: 10000,
    query_timeout: 10000, statement_timeout: 10000 });
try {
    await client.connect();
    console.log(JSON.stringify({ connected: true }));
    await client.query('SELECT 1');
    console.log(JSON.stringify({ simpleQuery: true }));
    const result = await client.query(`SELECT pid,application_name,state,wait_event_type,wait_event,
        extract(epoch FROM now()-xact_start)::integer AS transaction_seconds,
        split_part(ltrim(query),' ',1) AS command,
        CASE WHEN wait_event_type='Lock' THEN pg_blocking_pids(pid) ELSE ARRAY[]::integer[] END AS blockers
        FROM pg_stat_activity WHERE state<>'idle' AND pid<>pg_backend_pid() LIMIT 30`);
    console.log(JSON.stringify({ sessions: result.rows }));
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='5s'");
    try {
        const config = await client.query('SELECT page_id,enabled,split_messages FROM chatbot_configs LIMIT 15');
        console.log(JSON.stringify({ configs: config.rows }));
    } catch(error) { console.log(JSON.stringify({ configReadError: error.code || error.message })); }
    finally { await client.query('ROLLBACK'); }
} catch(error) { console.log(JSON.stringify({ error: error.code || error.message })); process.exitCode = 1; }
finally { await client.end().catch(() => {}); }
