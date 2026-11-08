import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let db: PGlite;
beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
        CREATE TABLE veo_tenants(id uuid PRIMARY KEY,launch_at timestamptz);
        CREATE TABLE veo_accounts(user_id uuid PRIMARY KEY,tenant_id uuid,parent_id uuid,active boolean,departed_at timestamptz);
        CREATE TABLE pages(id uuid PRIMARY KEY,veo_tenant_id uuid,veo_enabled boolean);
        CREATE TABLE user_pages(user_id uuid,page_id uuid,UNIQUE(user_id,page_id));`);
    await db.exec(readFileSync('supabase/migrations/202611090001_veo_hierarchy_recursion_guards.sql', 'utf8'));
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
    await db.exec('TRUNCATE veo_accounts,veo_tenants,pages,user_pages');
    await db.query('INSERT INTO veo_tenants VALUES($1,now()),($2,now())', [id(1), id(2)]);
    await db.query('INSERT INTO pages VALUES($1,$2,true),($3,$4,true)', [id(10),id(1),id(20),id(2)]);
    await db.query('INSERT INTO veo_accounts VALUES($1,$5,NULL,true,NULL),($2,$5,$1,true,NULL),($3,$5,$2,true,NULL),($4,$5,$3,true,NULL)', [id(100),id(101),id(102),id(103),id(1)]);
    await db.query('INSERT INTO user_pages SELECT user_id,$1 FROM veo_accounts', [id(10)]);
});
const branch = async (actor: number, fn = 'veo_descendants') => (await db.query<any>(`SELECT ${fn}($1) AS id`,[id(actor)])).rows.map(row => row.id).sort();
const allowed = async (actor: number, page = 10) => (await db.query<any>('SELECT veo_can_page($1,$2) AS allowed',[id(actor),id(page)])).rows[0].allowed;
it('keeps ordinary branch scope and inherited grants unchanged', async () => {
    expect(await branch(100)).toEqual([100,101,102,103].map(id));
    expect(await branch(102)).toEqual([102,103].map(id)); expect(await allowed(103)).toBe(true); expect(await allowed(103,20)).toBe(false);
    await db.query('DELETE FROM user_pages WHERE user_id=$1',[id(101)]); expect(await allowed(103)).toBe(false);
});
it('preserves offboarded ancestor semantics and nearest active grant parent', async () => {
    await db.query('UPDATE veo_accounts SET active=false,departed_at=now() WHERE user_id=$1',[id(102)]);
    await db.query('DELETE FROM user_pages WHERE user_id=$1',[id(102)]);
    expect(await branch(100,'veo_branch')).toContain(id(102)); expect(await branch(100)).not.toContain(id(102));
    expect(await allowed(103)).toBe(true);
    expect((await db.query<any>('SELECT veo_grant_parent($1) AS id',[id(103)])).rows[0].id).toBe(id(101));
    await db.query('UPDATE veo_accounts SET departed_at=NULL WHERE user_id=$1',[id(102)]); expect(await allowed(103)).toBe(false);
});
it('terminates a cyclic staff graph and denies affected page access', async () => {
    await db.query('UPDATE veo_accounts SET parent_id=$1 WHERE user_id=$2',[id(103),id(101)]);
    expect(await branch(101,'veo_branch')).toEqual([]); expect(await branch(101)).toEqual([]); expect(await allowed(103)).toBe(false);
    await db.exec('UPDATE veo_accounts SET active=false,departed_at=now()');
    expect((await db.query<any>('SELECT veo_grant_parent($1) AS id',[id(103)])).rows[0].id).toBeNull();
});
it('fails closed on self references, missing ancestry and cross-tenant parents', async () => {
    await db.query('UPDATE veo_accounts SET parent_id=user_id WHERE user_id=$1',[id(103)]); expect(await allowed(103)).toBe(false);
    await db.query('UPDATE veo_accounts SET parent_id=$1 WHERE user_id=$2',[id(999),id(103)]); expect(await allowed(103)).toBe(false);
    await db.query('INSERT INTO veo_accounts VALUES($1,$2,NULL,true,NULL)',[id(201),id(2)]);
    await db.query('INSERT INTO user_pages VALUES($1,$2)',[id(201),id(10)]);
    await db.query('UPDATE veo_accounts SET parent_id=$1 WHERE user_id=$2',[id(201),id(103)]); expect(await allowed(103)).toBe(false);
});
it('bounds unusually deep graphs and retains service-role-only execution', async () => {
    for(let n=104;n<=165;n++) await db.query('INSERT INTO veo_accounts VALUES($1,$2,$3,true,NULL)',[id(n),id(1),id(n-1)]);
    expect(await branch(100)).toEqual([]); expect(await allowed(165)).toBe(false);
    const acl=(await db.query<any>("SELECT has_function_privilege('anon','veo_can_page(uuid,uuid)','EXECUTE') AS anon,has_function_privilege('authenticated','veo_branch(uuid)','EXECUTE') AS client,has_function_privilege('service_role','veo_branch(uuid)','EXECUTE') AS service")).rows[0];
    expect(acl).toEqual({anon:false,client:false,service:true});
});
