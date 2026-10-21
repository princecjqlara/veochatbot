import pg from 'pg';
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
await db.connect();
try {
    const rows = (await db.query(`SELECT p.id,p.name,c.enabled,c.commercial_video_intake_enabled,c.split_messages,c.max_message_parts,
        c.knowledge_source_page_id,c.policy_revision,r.enabled AS recovery_enabled,r.checked_at,r.last_error
        FROM pages p LEFT JOIN chatbot_configs c ON c.page_id=p.id LEFT JOIN chatbot_inbound_recovery_pages r ON r.page_id=p.id
        ORDER BY p.name`)).rows;
    console.log(JSON.stringify({ pages: rows, configured: rows.filter(row => row.policy_revision !== null).length,
        enabled: rows.filter(row => row.enabled).length }, null, 2));
} finally { await db.end(); }
