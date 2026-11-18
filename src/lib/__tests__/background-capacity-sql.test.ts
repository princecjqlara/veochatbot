import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { schemaMigrationPlan } from '../../../scripts/lib/database-migration-safety.mjs';

let db: PGlite;
const functions = [
    ['veo_maintenance', '', 'void'],
    ['veo_operations_maintenance', '', 'jsonb'],
    ['veo_automatic_intake_tick', 'p_tenant uuid,p_now timestamptz DEFAULT clock_timestamp()', 'jsonb'],
    ['veo_refresh_worker_quota', 'p_user uuid,p_lease uuid', 'jsonb'],
    ['veo_auto_approve_pending_team_reviews', 'p_limit integer DEFAULT 20,p_supervisor uuid DEFAULT NULL', 'jsonb'],
    ['veo_refresh_all_discipline', '', 'jsonb'],
];
beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA app_private;
        CREATE TABLE app_private.schema_migrations(version text PRIMARY KEY,description text);
        CREATE TABLE calls(name text);`);
    for (const [name, args, result] of functions) await db.exec(`CREATE FUNCTION ${name}(${args}) RETURNS ${result} LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$BEGIN INSERT INTO calls VALUES('${name}');${result === 'void' ? 'RETURN;' : `RETURN '{"original":true}'::jsonb;`}END$$;REVOKE ALL ON FUNCTION ${name} FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION ${name} TO service_role;`);
    const migration = schemaMigrationPlan().find(m => m.name === '202611180001_veo_shared_background_capacity.sql')!;
    await db.exec('BEGIN');await db.exec(migration.sql);await db.exec('COMMIT');
}, 30000);
afterAll(async () => { await db?.close(); });
const calls = ['veo_maintenance()', 'veo_operations_maintenance()', 'veo_automatic_intake_tick(NULL)', 'veo_refresh_worker_quota(NULL,NULL)', 'veo_auto_approve_pending_team_reviews()', 'veo_refresh_all_discipline()'];
it('preserves original work, default parameters, service-only grants and function settings', async () => {
    await db.exec('BEGIN');
    try {
        for (const [i, expression] of calls.entries()) {
            const result = (await db.query<any>('SELECT ' + expression + ' result')).rows[0].result;
            if (i > 0) expect(result).toEqual({ original: true });
        }
        expect((await db.query('SELECT * FROM calls')).rows).toHaveLength(6);
        const grants = (await db.query<any>(`SELECT proname,prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service FROM pg_proc WHERE proname LIKE 'veo_%'`)).rows;
        expect(grants).toHaveLength(7);
        for (const fn of grants) {
            expect(fn).toMatchObject({ anon: false, authenticated: false, service: true, prosecdef: true });
            if (fn.proname !== 'veo_require_background_capacity') expect(fn.proconfig).toContain('jit=off');
        }
    } finally { await db.exec('ROLLBACK'); }
});
it('defers every heavy function before original side effects when admission is busy', async () => {
    await db.exec('BEGIN');
    try {
        // Inject a denied admission. Cross-connection lock contention requires
        // live PostgreSQL; this verifies integration into all original bodies.
        await db.exec(`CREATE OR REPLACE FUNCTION veo_require_background_capacity() RETURNS void LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'busy' USING ERRCODE='55P03';END$$;`);
        for (const expression of calls) {
            await db.exec('SAVEPOINT attempt');
            await expect(db.query('SELECT ' + expression)).rejects.toMatchObject({ code: '55P03' });
            await db.exec('ROLLBACK TO SAVEPOINT attempt;RELEASE SAVEPOINT attempt');
        }
        expect((await db.query('SELECT * FROM calls')).rows).toHaveLength(0);
    } finally { await db.exec('ROLLBACK'); }
});
