// Explicit --apply performs only additive schema changes. No bot settings,
// conversation ownership, lead records or customer notifications are changed.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import pg from 'pg';
const { parse } = createRequire(import.meta.url)('../../node_modules/dotenv');
const env = { ...parse(fs.readFileSync(new URL('../.env.local', import.meta.url))), ...process.env };
const db = new pg.Client({ connectionString: env.DATABASE_POOLER_URL_5432 || env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 90000 });
const apply = process.argv.includes('--apply');
const directory = new URL('../../data/sales-assistant-release-2026-10-30/', import.meta.url);
fs.mkdirSync(directory, { recursive: true });
const migrations = ['202610300001_guided_sales_intake.sql', '202610300002_chatbot_sales_assistant.sql'];
const hash = value => createHash('sha256').update(value).digest('hex');
const addedConfigFields = new Set(['guided_sales_enabled', 'sales_form_fields', 'sales_assistant_settings']);
const receipt = { at: new Date().toISOString(), applied: false, customerMessagesSent: 0, contactWrites: 0 };
async function functions() {
    return (await db.query(`SELECT p.oid::regprocedure::text AS identity, md5(pg_get_functiondef(p.oid)) AS hash
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prokind='f' AND (p.proname ILIKE '%chatbot%' OR p.proname ILIKE '%handoff%') ORDER BY 1`)).rows;
}
try {
    const productionEnvFile = new URL('../../data/sales-assistant-production-2026-10-30.env', import.meta.url);
    if (fs.existsSync(productionEnvFile)) {
        const production = parse(fs.readFileSync(productionEnvFile));
        assert.equal(new URL(production.NEXT_PUBLIC_SUPABASE_URL || production.SUPABASE_URL).hostname,
            new URL(env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL).hostname, 'Local migration target differs from production');
        receipt.productionTargetVerified = true;
    }
    await db.connect();
    const before = (await db.query('SELECT * FROM public.chatbot_configs ORDER BY page_id')).rows;
    const oldFunctions = await functions();
    const tracking = (await db.query(`SELECT table_schema,table_name,column_name,data_type FROM information_schema.columns
        WHERE table_schema IN ('app_private','supabase_migrations') AND table_name='schema_migrations' ORDER BY 1,2,ordinal_position`)).rows;
    receipt.configurationCount = before.length;
    receipt.enabledPagesBefore = before.filter(config => config.enabled).map(config => config.page_id);
    receipt.trackingColumns = tracking;
    receipt.existingPurposes = (await db.query('SELECT purpose,count(*)::int AS count FROM public.chatbot_follow_up_jobs GROUP BY purpose ORDER BY purpose')).rows;
    receipt.migrations = migrations.map(name => ({ name, sha256: hash(fs.readFileSync(new URL('../supabase/migrations/' + name, import.meta.url))) }));
    if (apply) {
        fs.writeFileSync(new URL('config-backup.json', directory), JSON.stringify(before, null, 2));
        await db.query('BEGIN');
        try {
            await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='90s'");
            for (const name of migrations) {
                const sql = fs.readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8').replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
                await db.query(sql);
            }
            const after = (await db.query('SELECT * FROM public.chatbot_configs ORDER BY page_id')).rows;
            assert.equal(after.length, before.length, 'Page count changed');
            for (const old of before) {
                const current = after.find(config => config.page_id === old.page_id);
                for (const field of Object.keys(old).filter(key => !addedConfigFields.has(key))) assert.deepEqual(current[field], old[field], 'Existing configuration changed: ' + field);
                if (!Object.hasOwn(old, 'sales_assistant_settings')) assert.deepEqual(current.sales_assistant_settings, {});
            }
            const currentFunctions = new Map((await functions()).map(item => [item.identity, item.hash]));
            for (const old of oldFunctions) assert.equal(currentFunctions.get(old.identity), old.hash, 'Existing handoff/chatbot function changed: ' + old.identity);
            assert.equal((await db.query("SELECT has_function_privilege('anon','public.merge_chatbot_sales_details(uuid,uuid,jsonb,jsonb,text,text,timestamptz,jsonb)','EXECUTE') AS allowed")).rows[0].allowed, false);
            assert.equal((await db.query("SELECT has_function_privilege('service_role','public.reserve_chatbot_sales_follow_up(uuid,uuid,timestamptz,uuid,integer)','EXECUTE') AS allowed")).rows[0].allowed, true);
            if (tracking.some(column => column.table_schema === 'app_private' && column.column_name === 'version')) {
                for (const name of migrations) await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES ($1,$2) ON CONFLICT(version) DO NOTHING',
                    [name.replace('.sql', '').split('_')[0], name.replace('.sql', '').replaceAll('_', ' ')]);
                receipt.tracking = 'app_private.schema_migrations';
            }
            if (tracking.some(column => column.table_schema === 'supabase_migrations' && column.column_name === 'statements')) {
                for (const name of migrations) await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES ($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING',
                    [name.split('_')[0], name.replace('.sql', '').split('_').slice(1).join('_'), [fs.readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')]]);
                receipt.supabaseHistoryRecorded = true;
            }
            await db.query('COMMIT');
            Object.assign(receipt, { applied: true, existingConfigurationsPreserved: true, existingHandoffFunctionsPreserved: true,
                enabledPagesAfter: after.filter(config => config.enabled).map(config => config.page_id), pricingDefault: 'OFF' });
        } catch (error) { await db.query('ROLLBACK'); throw error; }
    }
    fs.writeFileSync(new URL(apply ? 'migration-receipt.json' : 'inspection.json', directory), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
    console.error(JSON.stringify({ applied: receipt.applied, code: error.code || null, error: String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted connection]') })); process.exitCode = 1;
} finally { await db.end(); }
