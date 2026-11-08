// Read-only incident audit. Reports counts and sizes, never contact data.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { assertProjectCredentials, VEO_TARGET_PROJECT } from './lib/database-migration-safety.mjs';

export const contactStorageQueries = {
    database: `SELECT pg_database_size(current_database())::text AS bytes`,
    largestRelations: `SELECT n.nspname AS schema,c.relname AS relation,
        pg_total_relation_size(c.oid)::text AS total_bytes,
        pg_table_size(c.oid)::text AS table_and_toast_bytes,
        pg_indexes_size(c.oid)::text AS index_bytes,
        c.reltuples::bigint::text AS estimated_rows
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN('public','app_private') AND c.relkind IN('r','m')
        ORDER BY pg_total_relation_size(c.oid) DESC,n.nspname,c.relname LIMIT 20`,
    uniqueKeys: `SELECT t.relname AS relation,i.indisvalid AS valid,
        i.indisready AS ready,pg_get_expr(i.indpred,i.indrelid) AS predicate,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,position)
            JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
            WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns
        FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname='public' AND i.indisunique AND i.indexprs IS NULL
        AND t.relname IN('contacts','contact_tags','contact_profile_snapshots','veo_event_inbox')
        ORDER BY t.relname,i.indexrelid`,
    wal: `SELECT coalesce(sum(size),0)::bigint::text AS bytes FROM pg_ls_waldir()`,
    profileVersions: `SELECT coalesce(sum(versions),0)::bigint::text AS snapshots,
        count(*)::text AS contacts_with_profiles,
        coalesce(sum(versions-1),0)::bigint::text AS older_versions
        FROM (SELECT contact_id,count(*) AS versions FROM public.contact_profile_snapshots
            GROUP BY contact_id ORDER BY contact_id) version_counts`,
    matchingProfileSamples: `WITH sample AS MATERIALIZED (
        SELECT contact_id,md5(payload::text) AS payload_hash
        FROM public.contact_profile_snapshots ORDER BY contact_id,generation LIMIT 1000
        ), groups AS (
        SELECT count(*) AS copies FROM sample GROUP BY contact_id,payload_hash HAVING count(*)>1
        ) SELECT (SELECT count(*)::int FROM sample) AS sampled_rows,1000 AS sample_limit,
        count(*)::int AS matching_payload_groups,coalesce(sum(copies-1),0)::int AS extra_matching_versions
        FROM groups`,
    sameNameTagSamples: `WITH sample AS MATERIALIZED (
        SELECT owner_type,owner_id,lower(btrim(name)) AS tag_name FROM public.tags ORDER BY id LIMIT 5000
        ), groups AS (
        SELECT count(*) AS copies FROM sample GROUP BY owner_type,owner_id,tag_name HAVING count(*)>1
        ) SELECT (SELECT count(*)::int FROM sample) AS sampled_rows,5000 AS sample_limit,
        count(*)::int AS same_name_groups,coalesce(sum(copies-1),0)::int AS extra_same_name_tags FROM groups`,
};

export async function auditContactStorage(db, { scanSamples = false } = {}) {
    const report = { read_only: true, deleted_rows: 0, scans_requested: scanSamples, checks: {} };
    const scans = new Set(['profileVersions', 'matchingProfileSamples', 'sameNameTagSamples']);
    const deadline = Date.now() + 25000;
    for (const [name, sql] of Object.entries(contactStorageQueries)) {
        if (scans.has(name) && !scanSamples) continue;
        if (Date.now() >= deadline) { report.checks[name] = { status: 'unavailable', reason: 'audit_deadline' }; continue; }
        try {
            await db.query('BEGIN READ ONLY');
            await db.query("SET LOCAL statement_timeout='2500ms'");
            await db.query("SET LOCAL lock_timeout='500ms'");
            await db.query("SET LOCAL work_mem='2MB'");
            if (scans.has(name)) {
                // Do not let even a read-only scan spill to an almost full disk.
                // If this setting is forbidden, skip the scan rather than bypass it.
                await db.query("SET LOCAL temp_file_limit='0'");
                await db.query('SET LOCAL max_parallel_workers_per_gather=0');
            }
            const result = await db.query(sql);
            report.checks[name] = { status: 'complete', rows: result.rows };
        } catch (error) {
            report.checks[name] = { status: 'unavailable', code: error.code || 'QUERY_UNAVAILABLE' };
        } finally { await db.query('ROLLBACK').catch(() => {}); }
    }
    return report;
}

async function main() {
    if (!process.argv.includes('--inspect')) throw Error('Use --inspect; this command never deletes data');
    const { connectionString } = assertProjectCredentials(process.env, VEO_TARGET_PROJECT);
    const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false },
        application_name: 'veo-contact-storage-audit', connectionTimeoutMillis: 8000,
        query_timeout: 3500, statement_timeout: 2500 });
    db.on('error', () => {});
    const report = { project: VEO_TARGET_PROJECT, checked_at: new Date().toISOString(), read_only: true, deleted_rows: 0 };
    try {
        await db.connect();
        Object.assign(report, { connected: true }, await auditContactStorage(db, { scanSamples: process.argv.includes('--scan-samples') }));
    } catch (error) {
        Object.assign(report, { connected: false, code: error.code || 'CONNECTION_UNAVAILABLE' });
        process.exitCode = 1;
    } finally { await db.end().catch(() => {}); }
    const directory = '.vercel/contact-storage-audit';
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
