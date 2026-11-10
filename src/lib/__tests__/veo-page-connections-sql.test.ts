import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let db: PGlite;
beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
      CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean DEFAULT true);
      CREATE TABLE veo_tenants(id uuid PRIMARY KEY,owner_id uuid,launch_at timestamptz);
      CREATE TABLE veo_accounts(user_id uuid PRIMARY KEY REFERENCES users(id),tenant_id uuid,role text,active boolean DEFAULT true);
      CREATE TABLE pages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),fb_page_id text UNIQUE,name text,access_token text,veo_tenant_id uuid,veo_enabled boolean DEFAULT false,automation_app_id text,updated_at timestamptz DEFAULT now());
      CREATE TABLE user_pages(user_id uuid,page_id uuid,UNIQUE(user_id,page_id));
      CREATE TABLE veo_audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid,actor_id uuid,action text,entity_id uuid,before_value jsonb,after_value jsonb);
      CREATE TABLE contacts(id uuid,page_id uuid,name text);
      CREATE TABLE chatbot_configs(page_id uuid,instructions text);
      CREATE FUNCTION register_automation_page_owner(uuid,text) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
        IF $2<>'app' THEN RETURN false; END IF; UPDATE pages SET automation_app_id=$2 WHERE id=$1;RETURN FOUND;END $$;`);
    await db.exec(readFileSync('supabase/migrations/202611100001_veo_owner_page_connections.sql', 'utf8'));
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
    await db.exec('TRUNCATE veo_page_authorizations,veo_audit,contacts,chatbot_configs,user_pages,pages,veo_accounts,veo_tenants,users');
    await db.query('INSERT INTO users(id) VALUES($1),($2),($3)', [id(1), id(2), id(3)]);
    await db.query('INSERT INTO veo_tenants VALUES($1,$2,now()),($3,$4,now())', [id(10), id(1), id(20), id(3)]);
    await db.query("INSERT INTO veo_accounts(user_id,tenant_id,role) VALUES($1,$3,'owner'),($2,$3,'member'),($4,$5,'owner')", [id(1), id(2), id(10), id(3), id(20)]);
});
async function connect(actor = id(1), facebook = '123', name = 'New Page', token = 'private-page-token', app: string | null = 'app') {
    return (await db.query<any>('SELECT veo_connect_page($1,$2,$3,$4,$5) AS r', [actor, facebook, name, token, app])).rows[0].r;
}
it('adds a new verified Page ID and grants only the Owner without changing the launch cutoff', async () => {
    const before = (await db.query<any>('SELECT launch_at FROM veo_tenants WHERE id=$1', [id(10)])).rows[0];
    const saved = await connect(); expect(saved.created).toBe(true);
    expect((await db.query('SELECT user_id FROM user_pages WHERE page_id=$1', [saved.id])).rows).toEqual([{ user_id: id(1) }]);
    expect((await db.query<any>('SELECT launch_at FROM veo_tenants WHERE id=$1', [id(10)])).rows[0]).toEqual(before);
    expect(JSON.stringify((await db.query('SELECT * FROM veo_audit')).rows)).not.toContain('private-page-token');
});
it('reconnects in place while retaining staff access, contacts and chatbot settings', async () => {
    const saved = await connect();
    await db.query('INSERT INTO user_pages VALUES($1,$2)', [id(2), saved.id]);
    await db.query("INSERT INTO contacts VALUES($1,$2,'Saved Client')", [id(50), saved.id]);
    await db.query("INSERT INTO chatbot_configs VALUES($1,'Existing business instructions')", [saved.id]);
    const again = await connect(id(1), '123', 'Renamed Page', 'new-private-token');
    expect(again).toEqual({ id: saved.id, created: false });
    expect((await db.query('SELECT * FROM user_pages WHERE page_id=$1', [saved.id])).rows).toHaveLength(2);
    expect((await db.query<any>('SELECT name FROM contacts')).rows[0].name).toBe('Saved Client');
    expect((await db.query<any>('SELECT instructions FROM chatbot_configs')).rows[0].instructions).toBe('Existing business instructions');
    expect((await db.query('SELECT * FROM pages')).rows).toHaveLength(1);
});
it('rejects workers, inactive Owners and cross-tenant Page takeover', async () => {
    await expect(connect(id(2))).rejects.toThrow('Owner access');
    await connect(id(3)); await expect(connect()).rejects.toThrow('another workspace');
    await db.query('UPDATE users SET is_active=false WHERE id=$1', [id(1)]);
    await expect(connect(id(1), '456')).rejects.toThrow('Owner access');
});
it('cannot claim an unassigned legacy Page, and rolls back if app ownership fails', async () => {
    await db.query("INSERT INTO pages(fb_page_id,name,access_token) VALUES('789','Legacy','original-token')");
    await expect(connect(id(1), '789')).rejects.toThrow('another workspace or owner');
    await expect(connect(id(1), '456', 'Page', 'token', 'another-app')).rejects.toThrow('automation ownership');
    expect((await db.query("SELECT * FROM pages WHERE fb_page_id='456'")).rows).toHaveLength(0);
});
it('claims OAuth state once, rejects expired or cross-tenant state and keeps service functions private', async () => {
    await db.query("INSERT INTO veo_page_authorizations(id,actor_id,tenant_id,state_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')", [id(99), id(1), id(10), 'a'.repeat(64)]);
    const claim = async (hash = 'a'.repeat(64)) => (await db.query<any>('SELECT veo_claim_page_authorization($1,$2,$3) AS r', [id(1), id(99), hash])).rows[0].r;
    expect(await claim('b'.repeat(64))).toBe(false); expect(await claim()).toBe(true); expect(await claim()).toBe(false);
    await db.exec("UPDATE veo_page_authorizations SET state_used_at=NULL,expires_at=now()-interval '1 second'"); expect(await claim()).toBe(false);
    await db.query("UPDATE veo_page_authorizations SET expires_at=now()+interval '10 minutes',tenant_id=$1", [id(20)]); expect(await claim()).toBe(false);
    const exposed = (await db.query<any>("SELECT has_function_privilege('anon','veo_connect_page(uuid,text,text,text,text)','EXECUTE') OR has_table_privilege('authenticated','veo_page_authorizations','SELECT') AS value")).rows[0].value;
    expect(exposed).toBe(false);
});
