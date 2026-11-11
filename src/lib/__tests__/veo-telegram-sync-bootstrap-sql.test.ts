import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db: PGlite;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
      CREATE TABLE veo_tenants(id uuid PRIMARY KEY,launch_at timestamptz);
      CREATE TABLE veo_telegram_sync_state(tenant_id uuid PRIMARY KEY REFERENCES veo_tenants(id),next_sync_at timestamptz NOT NULL DEFAULT now(),lease_until timestamptz,cursor integer DEFAULT 0,auto_cursor integer DEFAULT 0,last_error text);
      CREATE TABLE retained_staff(id uuid PRIMARY KEY,active boolean,salary_minor bigint);`);
    await db.exec(readFileSync('supabase/migrations/202611110003_veo_telegram_sync_bootstrap.sql', 'utf8'));
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('TRUNCATE veo_tenants,veo_telegram_sync_state,retained_staff CASCADE'); });
it('starts reconciliation for a tenant launched after schema installation and fences a duplicate claim', async () => {
    await db.query('INSERT INTO veo_tenants VALUES($1,now()),($2,NULL)', [id(1), id(2)]);
    await db.query('INSERT INTO retained_staff VALUES($1,false,12345)', [id(3)]);
    const claim = (await db.query<any>('SELECT veo_claim_telegram_sync() job')).rows[0].job;
    expect(claim).toMatchObject({ tenant_id: id(1), cursor: 0, auto_cursor: 0 });
    expect((await db.query<any>('SELECT veo_claim_telegram_sync() job')).rows[0].job).toBeNull();
    expect((await db.query('SELECT tenant_id FROM veo_telegram_sync_state')).rows).toEqual([{ tenant_id: id(1) }]);
    expect((await db.query('SELECT active,salary_minor FROM retained_staff')).rows).toEqual([{ active: false, salary_minor: 12345 }]);
});
it('preserves ongoing pagination, scheduled future runs and held leases, and recovers an expired lease', async () => {
    await db.query('INSERT INTO veo_tenants VALUES($1,now()),($2,now())', [id(1), id(2)]);
    await db.query("INSERT INTO veo_telegram_sync_state(tenant_id,next_sync_at,lease_until,cursor,auto_cursor,last_error) VALUES($1,now()+interval '1 hour',NULL,8,4,'retry'),($2,now()-interval '1 minute',now()+interval '1 minute',12,3,NULL)", [id(1), id(2)]);
    expect((await db.query<any>('SELECT veo_claim_telegram_sync() job')).rows[0].job).toBeNull();
    await db.query("UPDATE veo_telegram_sync_state SET lease_until=now()-interval '1 minute' WHERE tenant_id=$1", [id(2)]);
    expect((await db.query<any>('SELECT veo_claim_telegram_sync() job')).rows[0].job).toMatchObject({ tenant_id: id(2), cursor: 12, auto_cursor: 3 });
    expect((await db.query('SELECT cursor,auto_cursor,last_error FROM veo_telegram_sync_state WHERE tenant_id=$1', [id(1)])).rows[0]).toEqual({ cursor: 8, auto_cursor: 4, last_error: 'retry' });
});
it('backfills an already launched recovered tenant idempotently and keeps the claim private', async () => {
    await db.query('INSERT INTO veo_tenants VALUES($1,now())', [id(1)]);
    const migration = readFileSync('supabase/migrations/202611110003_veo_telegram_sync_bootstrap.sql', 'utf8');
    await db.exec(migration); await db.exec(migration);
    expect((await db.query('SELECT * FROM veo_telegram_sync_state')).rows).toHaveLength(1);
    const access = (await db.query<any>("SELECT has_function_privilege('anon','veo_claim_telegram_sync()','EXECUTE') anon,has_function_privilege('authenticated','veo_claim_telegram_sync()','EXECUTE') authenticated,has_function_privilege('service_role','veo_claim_telegram_sync()','EXECUTE') service")).rows[0];
    expect(access).toEqual({ anon: false, authenticated: false, service: true });
});
