// Read-only schema/credential inventory. Does not invoke jobs or send messages.
import fs from 'node:fs';
import pg from 'pg';
import { assertProjectCredentials, schemaMigrationPlan, digest } from './lib/database-migration-safety.mjs';
import { migrationConnectionOptions } from './lib/migration-retry.mjs';
const expected = process.env.VEO_DATABASE_PROJECT_REF;
const endpoint = assertProjectCredentials(process.env, expected);
const plan = schemaMigrationPlan(), db = new pg.Client({ ...await migrationConnectionOptions(endpoint.connectionString), connectionTimeoutMillis: 8000, query_timeout: 15000 });
const features = {
    accounts: { tables: ['users', 'user_pages', 'veo_accounts', 'veo_tenants', 'veo_teams'], functions: ['veo_scope', 'veo_recover_account_login'] },
    chatbot: { tables: ['chatbot_configs', 'chatbot_knowledge_documents', 'chatbot_knowledge_chunks', 'chatbot_contact_states'], functions: [] },
    contacts_and_tags: { tables: ['contacts', 'tags', 'contact_tags'], functions: ['veo_seed_contact_identities'] },
    orders_and_payments: { tables: ['veo_orders', 'veo_payments', 'veo_business_orders'], functions: ['veo_observe_business_orders', 'veo_action'] },
    receipts_and_delivery: { tables: ['veo_receipts', 'veo_submissions', 'veo_photo_objects'], functions: ['veo_receipt_requirements', 'veo_handoff'] },
    calendar_and_costs: { tables: ['veo_ad_spend_coverage', 'veo_daily_targets'], functions: ['veo_calendar_inputs', 'veo_calendar_day_details', 'veo_calendar_created_orders', 'veo_finance_days'] },
    background_jobs: { tables: ['veo_event_inbox', 'veo_source_jobs', 'veo_background_job_leases'], functions: ['veo_claim_background_job', 'veo_release_background_job', 'veo_claim_events'] }
};
await db.connect();
try {
    await db.query('BEGIN READ ONLY'); await db.query("SET LOCAL statement_timeout='10s'");
    const installed = (await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations')).rows;
    const failures = [];
    for (const item of plan) {
        const recorded = installed.find(r => r.filename === item.name), original = fs.readFileSync('supabase/migrations/' + item.name, 'utf8').replace(/\r\n?/g, '\n');
        if (!recorded || recorded.project_ref !== expected || ![digest(original), digest(original.replace(/\n/g, '\r\n'))].includes(recorded.sha256)) failures.push(item.name);
    }
    const tables = new Set((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(r => r.tablename));
    const functions = new Set((await db.query("SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace")).rows.map(r => r.proname));
    const readiness = Object.fromEntries(Object.entries(features).map(([name, spec]) => {
        const missing = [...spec.tables.filter(t => !tables.has(t)), ...spec.functions.filter(f => !functions.has(f))];
        return [name, { schemaReady: !missing.length, missing }];
    }));
    const invalidIndexes = (await db.query("SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND(NOT i.indisvalid OR NOT i.indisready)")).rows;
    const privacy = (await db.query("SELECT bool_and(NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE')) private FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_claim_background_job','veo_release_background_job','veo_calendar_day_details','veo_calendar_created_orders','veo_recover_account_login','veo_seed_contact_identities')")).rows[0].private;
    const inventory = (await db.query("SELECT pg_database_size(current_database())::text database_bytes,(SELECT count(*) FROM veo_accounts) accounts,(SELECT count(*) FROM veo_accounts a JOIN users u ON u.id=a.user_id WHERE a.active AND(NOT u.is_active OR u.email IS NULL OR u.password_hash IS NULL)) account_logins_pending,(SELECT count(*) FROM chatbot_configs) chatbot_configurations,(SELECT count(*) FROM chatbot_knowledge_documents) knowledge_documents,(SELECT count(*) FROM contacts) contacts,(SELECT count(*) FROM veo_ad_spend_coverage) spend_coverage_rows")).rows[0];
    const largest = (await db.query("SELECT relname,pg_total_relation_size(relid)::text bytes FROM pg_catalog.pg_statio_user_tables WHERE schemaname='public' ORDER BY pg_total_relation_size(relid) DESC LIMIT 6")).rows;
    const bucket = (await db.query("SELECT public FROM storage.buckets WHERE id='veo-conversation-submissions'")).rows[0];
    const passed = !failures.length && !invalidIndexes.length && privacy === true && bucket?.public === false && Object.values(readiness).every(r => r.schemaReady);
    const report = { at: new Date().toISOString(), project: expected, passed, migrations: { expected: plan.length, installed: installed.length, failures }, publicTables: tables.size,
        features: readiness, privateRecoveryFunctions: privacy, privatePhotoBucket: bucket?.public === false, invalidIndexes, inventory, largestTables: largest,
        externalDependencies: 'Staff login details, current Facebook Page credentials, ad-account permissions/spend coverage and Telegram mappings require separate operational verification.', databaseWrites: 0 };
    await db.query('ROLLBACK');
    const output = process.argv.find(a => a.startsWith('--output='))?.slice(9);
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); if (!passed) process.exitCode = 1;
} finally { await db.end(); }
