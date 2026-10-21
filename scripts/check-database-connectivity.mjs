// Bounded read-only checks across existing configured connection routes.
import pg from 'pg';
const routes = process.argv.includes('--target-only') ? ['DATABASE_POOLER_URL_6543'] : ['DATABASE_POOLER_URL_5432', 'DATABASE_POOLER_URL_6543', 'DATABASE_URL'];
await Promise.all(routes.filter(name => process.env[name]).map(async route => {
    const client = new pg.Client({ connectionString: process.env[route], ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 8000, query_timeout: 8000, statement_timeout: 8000 });
    const start = Date.now();
    try {
        await client.connect();
        const result = process.argv.includes('--target-only')
            ? await client.query('SELECT page_id,enabled,split_messages,follow_up_enabled,commercial_video_intake_enabled FROM chatbot_configs WHERE page_id=$1', ['776b33f3-e492-43bd-a887-d451d7faa5a8'])
            : await client.query(`SELECT p.name,c.enabled,c.split_messages,c.follow_up_enabled,c.commercial_video_intake_enabled
                FROM pages p JOIN chatbot_configs c ON c.page_id=p.id WHERE p.name ILIKE '%Negosyo%'`);
        console.log(JSON.stringify({ route, elapsedMs: Date.now()-start, rows: result.rows }));
    } catch (error) { console.log(JSON.stringify({ route, elapsedMs: Date.now()-start, error: error.code || error.message })); }
    finally { await client.end().catch(() => {}); }
}));
