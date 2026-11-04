import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
const { parse } = createRequire(new URL('../package.json', import.meta.url))('dotenv');
const env = parse(fs.readFileSync('.env.local', 'utf8'));
const db = new pg.Client({ connectionString: env.DATABASE_POOLER_URL_5432 || env.DATABASE_URL, ssl: { rejectUnauthorized: false }, query_timeout: 120000 });
await db.connect();
try {
    const state = (await db.query(`SELECT
        (SELECT count(*)::bigint FROM public.contacts) AS contacts,
        (SELECT count(*)::bigint FROM public.contact_profile_snapshots) AS profiles,
        (SELECT count(*)::bigint FROM public.contact_profile_messages) AS raw_message_rows,
        to_regclass('public.contact_profile_transcripts') IS NULL AS raw_conversation_table_removed,
        (SELECT count(*)::bigint FROM public.contact_conversation_metrics) AS compact_conversation_metrics,
        (SELECT coalesce(sum(message_count),0)::bigint FROM public.contact_conversation_metrics) AS locally_analyzed_messages,
        (SELECT count(*)::bigint FROM public.contact_tags) AS tag_assignments,
        (SELECT count(*)::bigint FROM public.contact_verified_payments) AS verified_payments,
        current_setting('default_transaction_read_only') AS read_only`)).rows[0];
    const pages = (await db.query("SELECT id FROM public.pages WHERE fb_page_id=ANY($1::text[])", [JSON.parse(fs.readFileSync('src/config/veo-pages.json', 'utf8')).map(page => page.facebook_page_id)])).rows.map(row => row.id);
    const report = (await db.query("SELECT public.get_ad_calendar_report($1::uuid[],'2026-10-01T00:00:00+08:00','2026-11-01T00:00:00+08:00',NULL) AS data", [pages])).rows[0].data;
    const sums = Object.fromEntries(['inquiries','converted','orders','conversations_with_full_archive','customer_messages','page_messages','customer_messages_replied','attachment_references','image_references'].map(key =>
        [key, (report.groups || []).reduce((total, group) => total + Number(group[key] || 0), 0)]));
    console.log(JSON.stringify({ state, october_calendar_groups: report.groups?.length || 0, october_calendar: sums,
        zero_raw_message_storage: Number(state.raw_message_rows) === 0 && state.raw_conversation_table_removed }, null, 2));
} finally { await db.end(); }
