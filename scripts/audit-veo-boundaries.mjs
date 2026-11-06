import fs from 'node:fs';
import pg from 'pg';

// Read-only evidence: never create contacts, sales, accounts, or Telegram actions.
const db = new pg.Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000 });
try {
    await db.connect();
    await db.query('BEGIN READ ONLY');
    const exposedFunctions = (await db.query(`SELECT p.proname FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace AND p.prosecdef
      AND has_function_privilege('anon',p.oid,'EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      ORDER BY p.proname`)).rows;
    const exposedTables = (await db.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace
      AND c.relkind IN('r','p','v','m') AND has_table_privilege('anon',c.oid,'SELECT')
      AND (NOT c.relrowsecurity OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid))
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
      ORDER BY c.relname`)).rows;
    const state = (await db.query(`SELECT
      (SELECT count(*)::int FROM veo_accounts) AS accounts,
      (SELECT count(*)::int FROM veo_orders) AS orders,
      (SELECT count(*)::int FROM veo_teams WHERE telegram_chat_id IS NOT NULL) AS mapped_teams,
      (SELECT count(*)::int FROM veo_worker_mappings) AS mapped_workers,
      (SELECT count(*)::int FROM pages WHERE veo_enabled) AS active_pages,
      (SELECT count(*)::int FROM veo_submissions WHERE status IN('queued','processing')) AS pending_photos,
      (SELECT count(*)::int FROM veo_event_inbox WHERE status<>'done') AS pending_events,
      (SELECT count(*)::int FROM veo_event_inbox WHERE last_error IS NOT NULL) AS event_errors,
      (SELECT count(*)::int FROM veo_archive_records) AS archive_rows`)).rows[0];
    const legacyQueues = [];
    for (const table of ['chatbot_follow_up_jobs', 'chatbot_reply_events', 'workflow_automation_states', 'conversation_export_jobs']) {
        if (!(await db.query('SELECT to_regclass($1) IS NOT NULL AS present', ['public.' + table])).rows[0].present) continue;
        const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [table])).rows.map(r => r.column_name);
        if (columns.includes('status') && columns.includes('created_at')) {
            const rows = (await db.query(`SELECT status,count(*)::int AS count FROM ${table}
              WHERE created_at<(SELECT min(launch_at) FROM veo_tenants) GROUP BY status`)).rows;
            legacyQueues.push({ table, rows });
        }
    }
    await db.query('COMMIT');
    const result = { verified_at: new Date().toISOString(), exposed_functions: exposedFunctions,
        exposed_tables: exposedTables, state, legacy_queues: legacyQueues, database_boundary_passed: !exposedFunctions.length && !exposedTables.length };
    fs.writeFileSync('.vercel/workspace-boundary-audit.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} finally { await db.end(); }
