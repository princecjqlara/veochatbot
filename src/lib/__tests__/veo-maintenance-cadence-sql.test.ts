import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { schemaMigrationPlan } from '../../../scripts/lib/database-migration-safety.mjs';
let db: PGlite;
const first = '00000000-0000-4000-8000-000000000001', second = '00000000-0000-4000-8000-000000000002';
beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA app_private;
        CREATE TABLE app_private.schema_migrations(version text PRIMARY KEY,description text);
        CREATE FUNCTION veo_refresh_all_discipline() RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$SELECT '{}'::jsonb$$;
        CREATE FUNCTION veo_telegram_intake_maintenance() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$SELECT 0$$;`);
    await db.exec(schemaMigrationPlan().find(m => m.name === '202611210001_veo_maintenance_cadence.sql')!.sql);
}, 30000);
afterAll(async () => { await db?.close(); });
async function value(sql: string, args: unknown[] = []) { return (await db.query<any>('SELECT ' + sql + ' result', args)).rows[0].result; }
async function isolated(work: () => Promise<void>) { await db.exec('BEGIN');try { await work(); } finally { await db.exec('ROLLBACK'); } }
async function due() { await db.exec("UPDATE app_private.veo_maintenance_phases SET next_run_at=now()-interval '1 minute',leased_until=now()-interval '1 minute'"); }

it('admits one owner, preserves cadence after success, and keeps phases independent', () => isolated(async () => {
    expect(await value("veo_claim_maintenance_phase('salary',$1)", [first])).toBe(true);
    expect(await value("veo_claim_maintenance_phase('salary',$1)", [second])).toBe(false);
    expect(await value("veo_claim_maintenance_phase('operations',$1)", [second])).toBe(true);
    expect(await value("veo_finish_maintenance_phase('salary',$1,true)", [first])).toBe(true);
    expect(await value("veo_claim_maintenance_phase('salary',$1)", [second])).toBe(false);
    const rows = (await db.query<any>("SELECT phase,extract(epoch FROM next_run_at-now())::float8 seconds FROM app_private.veo_maintenance_phases ORDER BY phase")).rows;
    expect(rows[0].seconds).toBeGreaterThan(295);expect(rows[0].seconds).toBeLessThan(305);
    expect(rows[1].seconds).toBeGreaterThan(115);expect(rows[1].seconds).toBeLessThan(125);
}));
it('recovers abandoned leases and rejects completion by an expired owner', () => isolated(async () => {
    await value("veo_claim_maintenance_phase('salary',$1)", [first]);await due();
    expect(await value("veo_claim_maintenance_phase('salary',$1)", [second])).toBe(true);
    expect(await value("veo_finish_maintenance_phase('salary',$1,true)", [first])).toBe(false);
    expect(await value("veo_finish_maintenance_phase('salary',$1,true)", [second])).toBe(true);
}));
it('backs off repeated failures up to five minutes and clears failure state only on success', () => isolated(async () => {
    for (const seconds of [60, 120, 240, 300, 300]) {
        await due();expect(await value("veo_claim_maintenance_phase('salary',$1)", [first])).toBe(true);
        expect(await value("veo_finish_maintenance_phase('salary',$1,false)", [first])).toBe(true);
        const delay = await value("(SELECT extract(epoch FROM next_run_at-clock_timestamp())::float8 FROM app_private.veo_maintenance_phases WHERE phase='salary')");
        expect(delay).toBeGreaterThan(seconds - 5);expect(delay).toBeLessThan(seconds + 5);
        expect((await value('veo_maintenance_phase_status()')).healthy).toBe(false);
    }
    await due();await value("veo_claim_maintenance_phase('salary',$1)", [second]);
    await value("veo_finish_maintenance_phase('salary',$1,true)", [second]);
    expect(await value("(SELECT consecutive_failures FROM app_private.veo_maintenance_phases WHERE phase='salary')")).toBe(0);
}));
it('reports missing, failed and stale work instead of treating installed jobs as healthy', () => isolated(async () => {
    expect((await value('veo_maintenance_phase_status()')).healthy).toBe(false);
    for (const phase of ['salary', 'operations']) {
        await value('veo_claim_maintenance_phase($1,$2)', [phase, first]);
        await value('veo_finish_maintenance_phase($1,$2,true)', [phase, first]);
    }
    const healthy = await value('veo_maintenance_phase_status()');expect(healthy.healthy).toBe(true);
    expect(JSON.stringify(healthy)).not.toContain('lease_owner');
    await db.exec("UPDATE app_private.veo_maintenance_phases SET last_succeeded_at=now()-interval '11 minutes' WHERE phase='salary'");
    expect((await value('veo_maintenance_phase_status()')).healthy).toBe(false);
}));
it('requires service access, protects scheduling metadata and bounds the always-on SQL work', async () => {
    const fns = (await db.query<any>(`SELECT proname,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,
        has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service
        FROM pg_proc WHERE proname IN('veo_claim_maintenance_phase','veo_finish_maintenance_phase','veo_maintenance_phase_status')`)).rows;
    expect(fns).toHaveLength(3);for (const fn of fns) { expect(fn).toMatchObject({ anon: false, authenticated: false, service: true });expect(fn.proconfig).toContain('statement_timeout=2s'); }
    expect(await value("has_table_privilege('service_role','app_private.veo_maintenance_phases','INSERT,UPDATE,DELETE')")).toBe(false);
    const bounded = (await db.query<any>("SELECT proconfig FROM pg_proc WHERE proname IN('veo_refresh_all_discipline','veo_telegram_intake_maintenance')")).rows;
    for (const fn of bounded) { expect(fn.proconfig).toContain('statement_timeout=5s');expect(fn.proconfig).toContain('lock_timeout=1s'); }
});
