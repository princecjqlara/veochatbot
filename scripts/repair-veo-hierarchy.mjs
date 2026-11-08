import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { assertProjectCredentials, VEO_TARGET_PROJECT, digest } from './lib/database-migration-safety.mjs';

export const hierarchyMigration = '202611090001_veo_hierarchy_recursion_guards.sql';
const names = ['veo_branch', 'veo_descendants', 'veo_grant_parent', 'veo_can_page'];
const normalize = body => body.replace(/\s+/g, ' ').trim();
function bodyFrom(sql, name) {
    const pattern = new RegExp('CREATE(?: OR REPLACE)? FUNCTION (?:public\\.)?' + name + '\\([\\s\\S]*?\\bAS\\s+\\$\\$([\\s\\S]*?)\\$\\$;', 'gi');
    const found = [...sql.matchAll(pattern)];
    if (found.length !== 1) throw Error('Expected one hierarchy definition: ' + name);
    return found[0][1];
}
export function assertKnownHierarchyDefinitions(rows) {
    const before = fs.readFileSync('supabase/migrations/202611050020_veo_staff_and_delivery.sql', 'utf8');
    const after = fs.readFileSync('supabase/migrations/' + hierarchyMigration, 'utf8');
    if (rows.length !== names.length) throw Error('Expected all four existing hierarchy functions');
    for (const name of names) {
        const fn = rows.find(row => row.proname === name);
        if (!fn?.prosecdef || ![bodyFrom(before, name), bodyFrom(after, name)].some(body => normalize(body) === normalize(fn.prosrc))) {
            throw Error('Unexpected hierarchy definition; inspect before applying: ' + name);
        }
    }
}

async function main() {
    const apply = process.argv.includes('--apply');
    if (!apply && !process.argv.includes('--inspect')) throw Error('Choose --inspect or --apply');
    const { connectionString } = assertProjectCredentials(process.env, VEO_TARGET_PROJECT);
    const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, application_name: 'veo-hierarchy-recovery',
        connectionTimeoutMillis: 8000, query_timeout: 15000, statement_timeout: 10000 });
    db.on('error', () => {});
    try {
        await db.connect();
        const rows = (await db.query(`SELECT proname,prosrc,prosecdef,proconfig,oid::regprocedure::text AS signature
            FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`, [names])).rows;
        assertKnownHierarchyDefinitions(rows);
        console.log(JSON.stringify({ project: VEO_TARGET_PROJECT, connected: true, functions: rows.map(fn => ({ name: fn.proname, guarded: /visited/.test(fn.prosrc), sha256: digest(fn.prosrc) })) }));
        if (!apply) return;
        const original = fs.readFileSync('supabase/migrations/' + hierarchyMigration, 'utf8');
        await db.query('BEGIN');
        await db.query("SET LOCAL lock_timeout='3s';SET LOCAL statement_timeout='10s'");
        const locked = await db.query('SELECT pg_try_advisory_xact_lock(76110901) AS acquired');
        if (!locked.rows[0].acquired) throw Error('Hierarchy recovery is already running');
        await db.query(original.replace(/^[ \t]*(?:BEGIN|COMMIT);[ \t]*$/gm, ''));
        // Retain any operator-set function limits while replacing the SQL body.
        for (const fn of rows) for (const setting of fn.proconfig || []) {
            const equals = setting.indexOf('='), key = setting.slice(0, equals), value = setting.slice(equals + 1);
            if (key === 'search_path') continue;
            const signature = fn.signature.replace(/^public\./, '').replaceAll(' ', '');
            if (!/^[a-z_][a-z0-9_.]*$/.test(key) || !/^veo_[a-z_]+\(uuid(?:,uuid)?\)$/.test(signature)) throw Error('Unexpected function setting');
            await db.query(`ALTER FUNCTION public.${signature} SET ${key} TO '${value.replaceAll("'", "''")}'`);
        }
        const tracking = (await db.query("SELECT to_regclass('app_private.schema_migrations') IS NOT NULL AS present")).rows[0];
        if (tracking.present) await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT(version) DO NOTHING', ['202611090001', hierarchyMigration]);
        if ((await db.query("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS present")).rows[0].present) {
            await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING', ['202611090001', hierarchyMigration.replace('.sql', ''), [original]]);
        }
        await db.query('COMMIT');
        console.log(JSON.stringify({ applied: true, migration: hierarchyMigration, sha256: digest(original) }));
    } catch (error) {
        console.error(JSON.stringify({ applied: false, code: error.code, error: String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[connection]').slice(0, 500) }));
        process.exitCode = 1;
    } finally { await db.end().catch(() => {}); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
