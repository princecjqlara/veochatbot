import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { schemaMigrationPlan } from '../../../scripts/lib/database-migration-safety.mjs';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner=id(1), page=id(2), client=id(3), leader=id(4), manager=id(5), member=id(6);
let db: PGlite, tenant: string, source: string;
const rpc = async (name: string, args: any[]) => (await db.query<any>(`SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) r`,args)).rows[0].r;
const action = (kind: string, data: any) => rpc('veo_action',[member,kind,JSON.stringify(data)]);
const importOrder = () => action('import_business_order',{business_order_id:source,seller_id:member,deal_mode:'new'});
const requirements = (kind: string, order: string | null) => rpc('veo_receipt_requirements',[member,client,member,kind,order,true]);
beforeAll(async () => {
    db=await PGlite.create({extensions:{'uuid-ossp':uuid_ossp,pg_trgm,vector}});
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA extensions;CREATE SCHEMA cron;
      CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text);CREATE TABLE cron.job_run_details(end_time timestamptz);
      CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS 'INSERT INTO cron.job(jobname) VALUES($1) RETURNING jobid';
      CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobid=$1 RETURNING true';`);
    for(const migration of schemaMigrationPlan()) await db.exec(migration.sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;/g,'-- scheduler stub'));
    await db.query("INSERT INTO users(id,email,name) VALUES($1,'owner@example.com','CJ Lara')",[owner]);
    await db.query("INSERT INTO pages(id,fb_page_id,name,access_token) VALUES($1,'111','VEO','test')",[page]);
    await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)',[owner,page]); tenant=await rpc('veo_launch',[owner,[page]]);
    await db.query("UPDATE veo_tenants SET launch_at=now()-interval '2 days' WHERE id=$1",[tenant]);
    for(const [user,parent,role] of [[leader,owner,'team_leader'],[manager,leader,'manager'],[member,manager,'member']]) await rpc('veo_action',[owner,'create_account',JSON.stringify({user_id:user,parent_id:parent,role,name:role,email:user+'@example.com',password_hash:'x'.repeat(40),page_ids:[page]})]);
    await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage,last_interaction_at) VALUES($1,$2,'123456','Client','qualified',now())",[client,page]);
    await db.query('INSERT INTO veo_client_claims(contact_id,tenant_id,page_id,user_id) VALUES($1,$2,$3,$4)',[client,tenant,page,member]);
    await db.query('UPDATE veo_teams SET telegram_chat_id=-100123 WHERE manager_id=$1',[manager]);
    await db.query('INSERT INTO veo_worker_mappings VALUES($1,4242)',[member]);
    const at=new Date(Date.now()-5000).toISOString();
    const invoice={invoice_id:'123',message_id:'created-order',total_minor:10000,currency:'PHP',occurred_at:at};
    await rpc('veo_record_facebook_check',[member,client,new Date().toISOString(),JSON.stringify({orders:[invoice],complete:true,pages_checked:1,stage:{stage:'qualified',message_id:'qualified-stage',occurred_at:at}})]);
    source=(await rpc('veo_business_orders_page',[member,client])).items[0].id;
},120000);
beforeEach(async()=>{await db.exec('BEGIN');}); afterEach(async()=>{await db.exec('ROLLBACK');}); afterAll(async()=>{await db?.close();});
it('blocks a Closed Deal without the matching created order, including direct receipt-save requests',async()=>{
    const result=await requirements('closed',null); expect(result.allowed).toBe(false); expect(result.blockers).toContain('closed_order_required');
    const path=`${tenant}/${member}/${id(90)}`; await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)',[path]);
    await expect(rpc('veo_receipt_save',[member,JSON.stringify({request_id:id(91),seller_id:member,contact_id:client,receipt_kind:'closed',deal_mode:'new',object_path:path,photo_sha256:'a'.repeat(64),closed_amount_minor:4000,closed_currency:'PHP',closed_occurred_at:new Date(Date.now()-1000).toISOString()})])).rejects.toThrow();
});
it('creates and links an order without adding any payment, Paid status or Done Deal',async()=>{
    const order=await importOrder(); const fact=(await db.query<any>('SELECT paid_minor,done_at FROM veo_order_facts WHERE id=$1',[order.id])).rows[0];
    expect(fact).toEqual({paid_minor:0,done_at:null}); expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);
    expect((await requirements('closed',order.id)).allowed).toBe(true);
    expect((await requirements('done',order.id)).blockers).toContain('verify_full_payment');
});
it('keeps Closed Deal and Done Deal tied to one order and records settlement only through the separate payment action',async()=>{
    const order=await importOrder(),path=`${tenant}/${member}/${id(92)}`;await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)',[path]);
    const closed=await rpc('veo_receipt_save',[member,JSON.stringify({request_id:id(93),seller_id:member,contact_id:client,order_id:order.id,receipt_kind:'closed',deal_mode:'new',object_path:path,photo_sha256:'b'.repeat(64),closed_amount_minor:4000,closed_currency:'PHP',closed_occurred_at:new Date(Date.now()-5000).toISOString()})]);
    expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);
    expect((await db.query<any>('SELECT done_at FROM veo_order_facts WHERE id=$1',[order.id])).rows[0].done_at).toBeNull();
    const payload={request_id:id(94),order_id:order.id,closed_deal_id:closed.closed_deal_id,settle_done:true,kind:'balance',amount_minor:6000,confirmed:true,reference:'VERIFIED-BALANCE',occurred_at:new Date(Date.now()-1000).toISOString()};
    const result=await action('payment',payload);expect(await action('payment',payload)).toEqual(result);
    const fact=(await db.query<any>('SELECT paid_minor,done_at FROM veo_order_facts WHERE id=$1',[order.id])).rows[0];expect(fact.paid_minor).toBe(10000);expect(fact.done_at).not.toBeNull();
    expect((await db.query('SELECT * FROM veo_orders WHERE contact_id=$1',[client])).rows).toHaveLength(1);expect((await db.query('SELECT * FROM veo_closed_deals WHERE order_id=$1',[order.id])).rows).toHaveLength(1);
    expect((await requirements('done',order.id)).allowed).toBe(true);
    const donePath=`${tenant}/${member}/${id(96)}`;await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)',[donePath]);
    const done=await rpc('veo_receipt_save',[member,JSON.stringify({request_id:id(97),seller_id:member,contact_id:client,order_id:order.id,closed_deal_id:closed.closed_deal_id,receipt_kind:'done',deal_mode:'existing',object_path:donePath,photo_sha256:'c'.repeat(64)})]);
    expect(done.order_id).toBe(order.id);expect(done.closed_deal_id).toBe(closed.closed_deal_id);
    expect((await db.query('SELECT * FROM veo_receipts WHERE order_id=$1',[order.id])).rows).toHaveLength(2);
});
it('retains payment, stage and invoice-conflict guards and service-only permissions',async()=>{
    const order=await importOrder();await db.query('UPDATE veo_business_orders SET price_conflict=true WHERE id=$1',[source]);
    expect((await requirements('closed',order.id)).blockers).toContain('facebook_matching_order_required');
    const row=(await db.query<any>("SELECT has_function_privilege('anon','veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean)','EXECUTE') OR has_function_privilege('authenticated','veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean)','EXECUTE') exposed")).rows[0]; expect(row.exposed).toBe(false);
});
it('still rejects an unrelated earlier Closed Deal on a separate new order',async()=>{
    const order=await importOrder();
    const closed=(await db.query<any>(`INSERT INTO veo_closed_deals(tenant_id,team_id,page_id,contact_id,seller_id,amount_minor,currency,occurred_at,created_by)
      SELECT $1,id,$2,$3,$4,4000,'PHP',now()-interval '1 minute',$4 FROM veo_teams WHERE manager_id=$5 RETURNING id`,[tenant,page,client,member,manager])).rows[0];
    await expect(action('payment',{request_id:id(95),order_id:order.id,closed_deal_id:closed.id,settle_done:true,amount_minor:6000,confirmed:true,reference:'UNRELATED',occurred_at:new Date().toISOString()})).rejects.toThrow(/separate new deal/);
});
