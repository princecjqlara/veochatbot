import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import pg from 'pg';
import { assertProjectCredentials, VEO_TARGET_PROJECT } from './lib/database-migration-safety.mjs';

const apply = process.argv.includes('--apply');
if (!apply && !process.argv.includes('--preflight')) throw Error('Choose --preflight or --apply');
const { parse } = createRequire(import.meta.url)('dotenv');
const env = parse(fs.readFileSync('.env.local', 'utf8'));
const { connectionString } = assertProjectCredentials(env, VEO_TARGET_PROJECT);
const dir = path.resolve('.vercel/veo-backlog');
const prepared = JSON.parse(fs.readFileSync(path.join(dir, 'conversation-metrics-preflight.json'), 'utf8'));
assert(prepared.status === 'complete' && prepared.target_project === VEO_TARGET_PROJECT && prepared.raw_messages_written === 0, 'A completed local metrics preflight is required');
const archiveCheck = JSON.parse(fs.readFileSync(path.join(dir, 'conversation-archive-publication.json'), 'utf8'));
assert(archiveCheck.status === 'preflight_complete' && archiveCheck.target_project === VEO_TARGET_PROJECT && archiveCheck.sources >= prepared.matched,
    'Verified local conversation archive preflight is missing or incomplete');
const migrations = ['202611050004_preserve_order_created_paid_history.sql', '202611050005_contextual_payment_cohort_metrics.sql', '202611050006_local_only_raw_conversations.sql'];
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 25000, query_timeout: 120000 });
const report = { target_project: VEO_TARGET_PROJECT, applied: false, migrations: [], local_profiles_ready: prepared.matched,
    raw_messages_written: 0, errors: [] };
try {
    await db.connect();
    if (apply) {
        await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
        const mode = (await db.query('SELECT current_setting(\'transaction_read_only\') AS read_only')).rows[0].read_only;
        assert(mode === 'off', 'Supabase refused the documented session-level read-write recovery; no cleanup was attempted');
    }
    const before = (await db.query(`SELECT
        (SELECT count(*)::bigint FROM public.contacts) AS contacts,
        (SELECT count(*)::bigint FROM public.contact_profile_snapshots) AS profiles,
        (SELECT count(*)::bigint FROM public.contact_profile_messages) AS raw_message_rows,
        (SELECT count(*)::bigint FROM public.contact_profile_transcripts) AS raw_conversations,
        (SELECT count(*)::bigint FROM public.contact_tags) AS tag_assignments,
        (SELECT count(*)::bigint FROM public.contact_verified_payments) AS verified_payments,
        (SELECT md5(coalesce(string_agg(to_jsonb(c)::text,',' ORDER BY c.page_id),'') ) FROM public.chatbot_configs c) AS chatbot_configs`)).rows[0];
    report.before = before;
    assert(Number(before.raw_conversations) > 0 && Number(before.raw_message_rows) > 0, 'Expected raw conversation tables are empty or missing; stop for review');
    if (apply) {
        const tracked = new Set((await db.query("SELECT version FROM app_private.schema_migrations WHERE version=ANY($1::text[])", [migrations.map(file => file.slice(0, 12))])).rows.map(row => row.version));
        for (const file of migrations) {
            const version = file.slice(0, 12), name = file.slice(13, -4), sql = fs.readFileSync(path.join('supabase/migrations', file), 'utf8');
            if (tracked.has(version)) { report.migrations.push({ version, skipped: 'already_applied' }); continue; }
            await db.query(sql);
            if ((await db.query("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS exists")).rows[0].exists)
                await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING', [version, name, [sql]]);
            report.migrations.push({ version, applied: true });
        }
    } else report.migrations = migrations.map(file => ({ version: file.slice(0, 12), preflight: true }));
    const after = apply ? (await db.query(`SELECT
        (SELECT count(*)::bigint FROM public.contacts) AS contacts,
        (SELECT count(*)::bigint FROM public.contact_profile_snapshots) AS profiles,
        (SELECT count(*)::bigint FROM public.contact_profile_messages) AS raw_message_rows,
        (SELECT to_regclass('public.contact_profile_transcripts') IS NULL) AS raw_conversation_table_removed,
        (SELECT count(*)::bigint FROM public.contact_conversation_metrics) AS conversation_metrics,
        (SELECT count(*)::bigint FROM public.contact_tags) AS tag_assignments,
        (SELECT count(*)::bigint FROM public.contact_verified_payments) AS verified_payments,
        (SELECT md5(coalesce(string_agg(to_jsonb(c)::text,',' ORDER BY c.page_id),'') ) FROM public.chatbot_configs c) AS chatbot_configs`)).rows[0] : null;
    if (after) {
        assert(after.raw_conversation_table_removed && Number(after.raw_message_rows) === 0, 'Raw conversation storage remains after cleanup');
        assert(Number(after.conversation_metrics) >= Number(before.raw_conversations), 'Compact metrics did not preserve every previously archived conversation');
        for (const field of ['contacts', 'profiles', 'tag_assignments', 'verified_payments', 'chatbot_configs']) assert(after[field] === before[field], `${field} changed during cleanup`);
        report.after = after; report.applied = true;
    }
    report.status = apply ? 'complete' : 'preflight_complete';
} catch (error) {
    report.status = 'failed'; report.errors.push({ message: error instanceof Error ? error.message : 'Unknown migration error' });
    process.exitCode = 1;
} finally {
    await db.end();
    fs.writeFileSync(path.join(dir, apply ? 'local-conversation-cleanup.json' : 'local-conversation-cleanup-preflight.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
