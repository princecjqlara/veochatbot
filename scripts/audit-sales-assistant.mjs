// Read-only schema/configuration verification. No customer data is exported.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { parse } = require('../../node_modules/dotenv');
const env = parse(fs.readFileSync(new URL('../.env.local', import.meta.url)));
const db = new pg.Client({ connectionString: env.DATABASE_POOLER_URL_5432 || env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 15000 });
try {
    await db.connect(); await db.query('BEGIN READ ONLY');
    const schema = await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('chatbot_configs','chatbot_contact_states','chatbot_follow_up_jobs','chatbot_media_assets','chatbot_drive_files') ORDER BY table_name,column_name");
    const configs = await db.query('SELECT count(*)::int AS pages, count(*) FILTER (WHERE enabled)::int AS enabled, count(*) FILTER (WHERE commercial_video_intake_enabled)::int AS commercial FROM chatbot_configs');
    const rpc = await db.query("SELECT to_regprocedure('public.merge_chatbot_sales_details(uuid,uuid,jsonb,jsonb,text,text,timestamptz,jsonb)') IS NOT NULL AS installed");
    await db.query('ROLLBACK');
    const report = { readOnly: true, at: new Date().toISOString(), configurationCounts: configs.rows[0], schemaColumns: schema.rows,
        salesMigrationInstalled: rpc.rows[0].installed, productionWrites: 0, customerMessagesSent: 0 };
    fs.writeFileSync(new URL('../../data/sales-assistant-schema-audit-2026-10-30.json', import.meta.url), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ readOnly: true, configurationCounts: report.configurationCounts, salesMigrationInstalled: report.salesMigrationInstalled, productionWrites: 0, customerMessagesSent: 0 }));
} finally { await db.end(); }
