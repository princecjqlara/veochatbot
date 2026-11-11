import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { schemaMigrationPlan } from '../../../scripts/lib/database-migration-safety.mjs';
import { hashSync } from 'bcryptjs';
const stored='veo-sha256:'+hashSync('fixture',4);
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner=id(1),page=id(2),leader=id(3),manager=id(4),member=id(5),other=id(6),client=id(7),clientB=id(8);
let db:PGlite,tenant:string,seq=100;
const rpc=async(name:string,args:any[])=>{await db.exec('SAVEPOINT operation');try{const r=(await db.query<any>(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;await db.exec('RELEASE SAVEPOINT operation');return r;}catch(e){await db.exec('ROLLBACK TO SAVEPOINT operation;RELEASE SAVEPOINT operation');throw e;}};
beforeAll(async()=>{
 db=await PGlite.create({extensions:{'uuid-ossp':uuid_ossp,pg_trgm,vector}});
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA extensions;CREATE SCHEMA cron;CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY,jobname text,schedule text,command text);CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS 'INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) RETURNING jobid';CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobid=$1 RETURNING true';`);
 for(const m of schemaMigrationPlan())await db.exec(m.sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;/g,'-- stub'));
 await db.query("INSERT INTO users(id,email,name,password_hash) VALUES($1,'owner@example.com','Owner','test')",[owner]);
 await db.query("INSERT INTO pages(id,fb_page_id,name,access_token) VALUES($1,'111','Test Page','test')",[page]);await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)',[owner,page]);
 await db.exec('BEGIN');tenant=await rpc('veo_launch',[owner,[page]]);
 for(const [actor,user,parent,role] of [[owner,leader,owner,'team_leader'],[leader,manager,leader,'manager'],[manager,member,manager,'member'],[owner,other,owner,'manager']])await rpc('veo_action',[actor,'create_account',JSON.stringify({user_id:user,parent_id:parent,role,name:role,email:user+'@example.com',password_hash:stored,page_ids:[page]})]);
 await db.query('INSERT INTO veo_deal_review_settings(tenant_id,enabled) VALUES($1,true)',[tenant]);
 await db.query("INSERT INTO contacts(id,page_id,psid,name) VALUES($1,$3,'a','Client A'),($2,$3,'b','Client B')",[client,clientB,page]);await db.exec('COMMIT');
},60000);
afterAll(async()=>{await db?.close();});beforeEach(async()=>{await db.exec('BEGIN');});afterEach(async()=>{await db.exec('ROLLBACK');});
async function evidence(kind='closed',extra:any={}){
 const data={request_id:id(seq++),contact_id:client,seller_id:member,receipt_kind:kind,currency:'PHP',total_price_minor:100000,closed_amount_minor:kind==='closed'?30000:0,received_now_minor:kind==='done'?70000:0,tip_minor:0,occurred_at:new Date().toISOString(),description:'Test deal',notes:'',...extra};const photos:string[]=[];
 for(const slot of ['stage','payment','order']){const p=id(seq++),path='test/'+p;await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)',[path]);await db.query('INSERT INTO veo_deal_review_photos(id,request_id,tenant_id,page_id,contact_id,seller_id,uploaded_by,receipt_kind,slot,object_path,photo_sha256) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10)',[p,data.request_id,tenant,page,data.contact_id,member,kind,slot,path,seq.toString(16).padStart(64,'0')]);photos.push(p);}return {data,photos};
}
const submit=(e:any)=>rpc('veo_submit_deal_review',[member,JSON.stringify(e.data),e.photos]);
const approve=(r:any,actor=owner)=>rpc('veo_review_deal',[actor,r.id,'approve',true,true,true,'Checked all evidence']);
it('keeps pending evidence out of the ledger and returns idempotent retries',async()=>{
 const e=await evidence(),r=await submit(e);expect(r.status).toBe('pending');expect(r.photos).toHaveLength(3);expect((await submit(e)).duplicate).toBe(true);
 for(const table of ['veo_orders','veo_closed_deals','veo_payments','veo_submissions'])expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
 expect((await db.query<any>('SELECT pipeline_stage FROM contacts WHERE id=$1',[client])).rows[0].pipeline_stage).toBe('new');
 await expect(submit({...e,data:{...e.data,closed_amount_minor:40000}})).rejects.toThrow('different evidence');
});
it('binds three distinct live photo slots to the selected contact and submitting staff',async()=>{
 const e=await evidence();await expect(submit({...e,data:{...e.data,contact_id:clientB}})).rejects.toThrow('selected contact');
 await expect(submit({...e,photos:[e.photos[0],e.photos[0],e.photos[2]]})).rejects.toThrow('different evidence');
 await db.query('UPDATE veo_deal_review_photos SET photo_sha256=repeat(\'a\',64) WHERE id=ANY($1)',[e.photos]);await expect(submit(e)).rejects.toThrow('selected contact');
});
it('requires independent in-branch supervision and all three confirmations',async()=>{
 const r=await submit(await evidence());await expect(approve(r,member)).rejects.toThrow('different authorized');await expect(approve(r,other)).rejects.toThrow('outside your branch');
 await expect(rpc('veo_review_deal',[owner,r.id,'approve',true,false,true,''])).rejects.toThrow('Confirm the stage');
 await expect(rpc('veo_review_deal',[owner,r.id,'reject',false,false,false,''])).rejects.toThrow('rejection reason');
 const no=await rpc('veo_review_deal',[manager,r.id,'reject',false,false,false,'Unreadable receipt']);expect(no.status).toBe('rejected');expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(0);
});
it('separates Close Deal from Done Deal, counts the deposit once and keeps tips out of principal',async()=>{
 const cd=await approve(await submit(await evidence()));expect(cd.status).toBe('approved');expect(cd.delivery_status).toBe('waiting_for_telegram_setup');
 expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);expect((await db.query<any>('SELECT done_at FROM veo_order_facts')).rows[0].done_at).toBeNull();
 const e=await evidence('done',{order_id:cd.order_id,closed_deal_id:cd.closed_deal_id,tip_minor:10000}),pending=await submit(e),dd=await approve(pending,leader);
 expect(dd.status).toBe('approved');expect((await approve(pending,leader)).id).toBe(dd.id);
 expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(1);expect((await db.query('SELECT * FROM veo_closed_deals')).rows).toHaveLength(1);
 const payments=(await db.query<any>('SELECT amount_minor,kind FROM veo_payments ORDER BY amount_minor')).rows;expect(payments.map(p=>Number(p.amount_minor))).toEqual([30000,70000]);expect(payments.map(p=>p.kind)).toEqual(['deposit','balance']);
 expect(Number((await db.query<any>('SELECT amount_minor FROM veo_deal_tips')).rows[0].amount_minor)).toBe(10000);expect((await db.query<any>('SELECT done_at FROM veo_order_facts')).rows[0].done_at).not.toBeNull();
 const facts=await rpc('veo_deal_reviews_page',[owner,'all',client,0,30]);expect(facts.total).toBe(2);expect(facts.items.every((r:any)=>r.tip_commission_included===false)).toBe(true);
});
it('rejects wrong totals atomically and refuses linking another contact order',async()=>{
 const cd=await approve(await submit(await evidence()));const e=await evidence('done',{order_id:cd.order_id,closed_deal_id:cd.closed_deal_id,received_now_minor:100000});const r=await submit(e);
 await expect(approve(r)).rejects.toThrow('settle the price');expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);expect((await rpc('veo_deal_review_access',[owner,r.id])).status).toBe('pending');
 await expect(submit(await evidence('done',{contact_id:clientB,order_id:cd.order_id,closed_deal_id:cd.closed_deal_id}))).rejects.toThrow('existing Close Deal');
});
it('queues both milestones only after approval and current Telegram mapping, with all evidence',async()=>{
 const cd=await approve(await submit(await evidence()));const dd=await approve(await submit(await evidence('done',{order_id:cd.order_id,closed_deal_id:cd.closed_deal_id,tip_minor:5000})));
 await rpc('veo_sync_telegram_groups',[owner,JSON.stringify([{chat_id:-123,name:'Sales',pages:[{id:page,matched:true}],topics:{},identities:[]}])]);
 const team=(await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1',[manager])).rows[0].id;
 await rpc('veo_telegram_group_action',[manager,'group',JSON.stringify({team_id:team,chat_id:-123,page_ids:[page]})]);await rpc('veo_telegram_group_action',[manager,'membership',JSON.stringify({user_id:member,chat_id:-123,telegram_user_id:55})]);
 expect(await rpc('veo_enqueue_approved_deal_reviews',[20])).toBe(2);expect(await rpc('veo_enqueue_approved_deal_reviews',[20])).toBe(0);
 const submissions=(await db.query<any>('SELECT * FROM veo_submissions ORDER BY receipt_kind')).rows;expect(submissions).toHaveLength(2);
 for(const s of submissions){const h=await rpc('veo_handoff',[s.id]);expect(h.review_status).toBe('approved');expect(h.evidence_photos).toHaveLength(3);expect(h.contact_id).toBe(client);expect(h.reviewed_by).toBe(owner);if(s.receipt_kind==='done'){expect(Number(h.total_received_minor)).toBe(105000);expect(Number(h.done_amount_minor)).toBe(70000);}else expect(Number(h.total_received_minor)).toBe(30000);}
});
it('keeps evidence and review functions private and respects the rollout switch',async()=>{
 for(const fn of ['veo_review_deal(uuid,uuid,text,boolean,boolean,boolean,text)','veo_deal_review_access(uuid,uuid)','veo_submit_deal_review(uuid,jsonb,uuid[])'])expect((await db.query<any>("SELECT has_function_privilege('authenticated',$1,'EXECUTE') exposed",[fn])).rows[0].exposed).toBe(false);
 await db.query('UPDATE veo_deal_review_settings SET enabled=false WHERE tenant_id=$1',[tenant]);expect((await rpc('veo_scope',[owner])).reviewed_deals_enabled).toBe(false);await expect(submit(await evidence())).rejects.toThrow('permitted contact');
});
it('excludes old inquiries from the pool and rejects old acceptance buttons while retaining the contact',async()=>{
 await db.query('UPDATE veo_intake_auto_policy SET enabled=true,enabled_at=now() WHERE tenant_id=$1',[tenant]);
 await db.query("UPDATE contacts SET first_interaction_at=now()-interval '1 day',last_interaction_at=now(),last_inbound_at=now() WHERE id=$1",[client]);
 const pool=await rpc('veo_intake_page',[member,'pool',page,'',0]);expect(pool.items.some((c:any)=>c.id===client)).toBe(false);
 await expect(rpc('veo_intake_action',[member,'accept',JSON.stringify({contact_id:client,request_id:id(seq++)})])).rejects.toThrow('predates the new-client cutoff');
 expect((await db.query('SELECT * FROM contacts WHERE id=$1',[client])).rows).toHaveLength(1);expect((await submit(await evidence())).status).toBe('pending');
});
it('rejects reused photo bundles under a new request while allowing a corrected rejected submission',async()=>{
 const first=await evidence(),r=await submit(first),second=await evidence();
 await db.query('UPDATE veo_deal_review_photos incoming SET photo_sha256=prior.photo_sha256 FROM veo_deal_review_photos prior WHERE prior.review_id=$1 AND incoming.id=ANY($2) AND incoming.slot=prior.slot',[r.id,second.photos]);
 await expect(submit(second)).rejects.toThrow('already submitted');await rpc('veo_review_deal',[owner,r.id,'reject',false,false,false,'Please correct the details']);
 expect((await submit(second)).status).toBe('pending');
});
it('preserves accepted client ownership on new sales and rechecks reassignment before approval',async()=>{
 await db.query('INSERT INTO veo_client_claims(contact_id,tenant_id,page_id,user_id,claimed_at) VALUES($1,$2,$3,$4,now())',[client,tenant,page,other]);
 await expect(submit(await evidence())).rejects.toThrow('assigned seller');await db.query('UPDATE veo_client_claims SET user_id=$1 WHERE contact_id=$2',[member,client]);
 const pending=await submit(await evidence());await db.query('UPDATE veo_client_claims SET user_id=$1 WHERE contact_id=$2',[other,client]);
 await expect(approve(pending)).rejects.toThrow('assigned seller changed');expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(0);
});
it('allows the original seller to finish an existing Close Deal after client service is reassigned',async()=>{
 const cd=await approve(await submit(await evidence()));await db.query('INSERT INTO veo_client_claims(contact_id,tenant_id,page_id,user_id,claimed_at) VALUES($1,$2,$3,$4,now())',[client,tenant,page,other]);
 const dd=await approve(await submit(await evidence('done',{order_id:cd.order_id,closed_deal_id:cd.closed_deal_id})));expect(dd.status).toBe('approved');expect(dd.seller_id).toBe(member);
 expect((await db.query<any>('SELECT user_id FROM veo_client_claims WHERE contact_id=$1',[client])).rows[0].user_id).toBe(other);
});
