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
it('coordinates saved Page advertising discovery hourly and keeps source credentials service-only',async()=>{
 expect((await db.query<any>('SELECT veo_page_ads_discovery_candidates() owner')).rows.map(r=>r.owner)).toEqual([owner]);
 await expect(rpc('veo_claim_page_ads_discovery',[manager])).rejects.toThrow('Owner access');expect(await rpc('veo_claim_page_ads_discovery',[owner])).toBe(true);expect(await rpc('veo_claim_page_ads_discovery',[owner])).toBe(false);
 expect((await db.query('SELECT veo_page_ads_discovery_candidates()')).rows).toHaveLength(0);
 await db.query("UPDATE veo_ad_source_discovery SET next_attempt_at=now()-interval '1 second' WHERE user_id=$1",[owner]);expect(await rpc('veo_claim_page_ads_discovery',[owner])).toBe(true);
 for(const signature of ['veo_claim_page_ads_discovery(uuid)','veo_page_ads_discovery_candidates()'])expect((await db.query<any>("SELECT has_function_privilege('authenticated',$1,'EXECUTE') exposed",[signature])).rows[0].exposed).toBe(false);
});
async function evidence(kind='closed',extra:any={},actor=member){
 const data={request_id:id(seq++),contact_id:client,seller_id:member,receipt_kind:kind,currency:'PHP',total_price_minor:100000,closed_amount_minor:kind==='closed'?30000:0,received_now_minor:kind==='done'?70000:0,tip_minor:0,occurred_at:new Date().toISOString(),description:'Test deal',notes:'',...extra};const photos:string[]=[];
 for(const slot of ['stage','payment','order']){const p=id(seq++),path='test/'+p;await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)',[path]);await db.query('INSERT INTO veo_deal_review_photos(id,request_id,tenant_id,page_id,contact_id,seller_id,uploaded_by,receipt_kind,slot,object_path,photo_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[p,data.request_id,tenant,page,data.contact_id,data.seller_id,actor,kind,slot,path,seq.toString(16).padStart(64,'0')]);photos.push(p);}return {data,photos};
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
 await db.query("UPDATE veo_photo_objects SET expires_at=now()-interval '1 second' WHERE object_path=(SELECT object_path FROM veo_deal_review_photos WHERE id=$1)",[e.photos[0]]);await expect(submit(e)).rejects.toThrow('selected contact');
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
const directMode=()=>db.query('UPDATE veo_deal_review_settings SET supervisor_submissions_enabled=true WHERE tenant_id=$1',[tenant]);
const submitAs=(actor:string,e:any)=>rpc('veo_submit_deal_review',[actor,JSON.stringify(e.data),e.photos]);
it('corrects a Close Deal total and remaining balance without changing the down payment or replay identity',async()=>{
 const e=await evidence(),r=await approve(await submit(e));
 const changed=await rpc('veo_close_deal_price',[manager,r.id,120000,100000,'Customer changed package']);
 expect(Number(changed.total_price_minor)).toBe(120000);expect(Number(changed.closed_amount_minor)).toBe(30000);
 expect(Number((await db.query<any>('SELECT total_minor FROM veo_orders WHERE id=$1',[r.order_id])).rows[0].total_minor)).toBe(120000);
 expect((await submit(e)).duplicate).toBe(true);expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);
 await expect(rpc('veo_close_deal_price',[manager,r.id,130000,100000,'Stale correction'])).rejects.toThrow('price changed');
 const done=await approve(await submit(await evidence('done',{order_id:r.order_id,closed_deal_id:r.closed_deal_id,total_price_minor:120000,received_now_minor:90000})));
 expect(done.status).toBe('approved');await expect(rpc('veo_close_deal_price',[manager,r.id,130000,120000,'Already completed'])).rejects.toThrow('Done Deal');
});
it('restricts price correction to the supervisor branch and rejects totals below the deposit',async()=>{
 const r=await submit(await evidence());
 for(const actor of [member,owner,other])await expect(rpc('veo_close_deal_price',[actor,r.id,120000,100000,'Wrong price'])).rejects.toThrow();
 await expect(rpc('veo_close_deal_price',[manager,r.id,20000,100000,'Too low'])).rejects.toThrow('down payment');
 const changed=await rpc('veo_close_deal_price',[leader,r.id,110000,100000,'Correct package']);expect(Number(changed.total_price_minor)).toBe(110000);
});
it.each([manager,leader])('automatically approves staff milestones under an enabled supervisor policy',async actor=>{
 await rpc('veo_team_auto_approval_setting',[actor,true]);
 const cd=await submit(await evidence());expect(cd.status).toBe('approved');expect(cd.auto_approved).toBe(true);expect(cd.reviewed_by).toBe(actor);
 const dd=await submit(await evidence('done',{order_id:cd.order_id,closed_deal_id:cd.closed_deal_id}));expect(dd.status).toBe('approved');expect(dd.auto_approved).toBe(true);
 expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(2);
});
it('approves pending team evidence, enforces disabling, and rejects forged supervisor settings',async()=>{
 const e=await evidence(),pending=await submit(e);expect(pending.status).toBe('pending');
 for(const actor of [member,owner])await expect(rpc('veo_team_auto_approval_setting',[actor,true])).rejects.toThrow('Manager or Team Leader');
 await rpc('veo_team_auto_approval_setting',[other,true]);expect((await rpc('veo_auto_approve_pending_team_reviews',[20,other])).approved).toBe(0);
 await rpc('veo_team_auto_approval_setting',[manager,true]);expect((await rpc('veo_auto_approve_pending_team_reviews',[20,manager])).approved).toBe(1);
 expect((await submit(e)).duplicate).toBe(true);
 await rpc('veo_team_auto_approval_setting',[manager,false]);const next=await submit(await evidence('closed',{contact_id:clientB}));expect(next.status).toBe('pending');
});
it('keeps expired or deleted pending evidence out of automatic approval',async()=>{
 const e=await evidence(),r=await submit(e);await db.query("UPDATE veo_photo_objects SET expires_at=now()-interval '1 minute'");
 await rpc('veo_team_auto_approval_setting',[manager,true]);expect((await rpc('veo_auto_approve_pending_team_reviews',[20,manager])).needs_review).toBe(1);
 expect((await rpc('veo_deal_review_access',[manager,r.id])).status).toBe('pending');expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(0);
 await rpc('veo_deal_review_delete',[manager,r.id,'Invalid evidence']);expect((await rpc('veo_auto_approve_pending_team_reviews',[20,manager])).approved).toBe(0);
});
it('allows only scoped Managers and Team Leaders to delete receipts and blocks approval afterwards',async()=>{
 const r=await submit(await evidence());
 for(const actor of [member,owner,other])await expect(rpc('veo_deal_review_delete',[actor,r.id,'Wrong photo'])).rejects.toThrow();
 const deleted=await rpc('veo_deal_review_delete',[manager,r.id,'Wrong photo']);expect(deleted.deleted_by).toBe(manager);expect(deleted.can_review).toBe(false);expect(deleted.can_delete).toBe(false);
 await expect(approve(r)).rejects.toThrow('Deleted receipts');
 expect((await rpc('veo_deal_review_delete',[manager,r.id,'Retry'])).deleted_at).toBe(deleted.deleted_at);
});
it.each([manager,leader])('withdraws approved evidence and durably requests Telegram removal without deleting verified payments',async actor=>{
 await rpc('veo_sync_telegram_groups',[owner,JSON.stringify([{chat_id:-123,name:'Sales',pages:[{id:page,matched:true}],topics:{},identities:[]}])]);
 const team=(await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1',[manager])).rows[0].id;
 await rpc('veo_telegram_group_action',[manager,'group',JSON.stringify({team_id:team,chat_id:-123,page_ids:[page]})]);await rpc('veo_telegram_group_action',[manager,'membership',JSON.stringify({user_id:manager,chat_id:-123,telegram_user_id:55})]);
 await directMode();const r=await submitAs(manager,await evidence('done',{seller_id:manager,received_now_minor:100000},manager));
 const payments=(await db.query('SELECT * FROM veo_payments')).rows;expect(payments).toHaveLength(1);
 await rpc('veo_deal_review_delete',[actor,r.id,'Mistaken receipt']);
 expect(await rpc('veo_handoff',[r.delivery_submission])).toBeNull();expect(await rpc('veo_submission_receipt_deleted',[r.delivery_submission])).toBe(true);
 expect((await db.query('SELECT * FROM veo_receipt_deletion_outbox')).rows).toHaveLength(1);expect((await db.query('SELECT * FROM veo_payments')).rows).toEqual(payments);
 expect((await rpc('veo_deal_review_access',[actor,r.id])).deleted_at).toBeTruthy();
});
it.each([manager,leader])('allows a supervisor to switch off auto-approval without a retry promoting the receipt',async actor=>{
 await directMode();const e=await evidence('closed',{auto_approve:false},actor);
 const pending=await submitAs(actor,e);expect(pending.status).toBe('pending');
 expect((await db.query('SELECT * FROM veo_submissions')).rows).toHaveLength(0);
 await expect(submitAs(actor,{...e,data:{...e.data,auto_approve:true}})).rejects.toThrow('different evidence');
 const retry=await submitAs(actor,e);
 expect(retry.status).toBe('pending');expect(retry.duplicate).toBe(true);
 expect((await approve(pending)).status).toBe('approved');
});
it('records a manager own Close and Done Deal automatically, preserves separate tips and produces an attested handoff',async()=>{
 await directMode();const e=await evidence('closed',{seller_id:manager},manager),cd=await submitAs(manager,e);
 expect(cd.status).toBe('approved');expect(cd.approval_mode).toBe('supervisor_submission');expect(cd.reviewed_by).toBe(manager);expect(cd.submitted_by_role).toBe('manager');expect(cd.can_review).toBe(false);expect((await submitAs(manager,e)).duplicate).toBe(true);
 expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);
 const dd=await submitAs(manager,await evidence('done',{seller_id:manager,order_id:cd.order_id,closed_deal_id:cd.closed_deal_id,tip_minor:5000},manager));expect(dd.status).toBe('approved');
 expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(1);expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(2);expect((await db.query('SELECT * FROM veo_deal_tips')).rows).toHaveLength(1);
 await rpc('veo_sync_telegram_groups',[owner,JSON.stringify([{chat_id:-123,name:'Sales',pages:[{id:page,matched:true}],topics:{},identities:[]}])]);
 const team=(await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1',[manager])).rows[0].id;
 await rpc('veo_telegram_group_action',[manager,'group',JSON.stringify({team_id:team,chat_id:-123,page_ids:[page]})]);await rpc('veo_telegram_group_action',[manager,'membership',JSON.stringify({user_id:manager,chat_id:-123,telegram_user_id:55})]);
 expect(await rpc('veo_enqueue_approved_deal_reviews',[20])).toBe(2);
 for(const s of (await db.query<any>('SELECT id FROM veo_submissions')).rows){const h=await rpc('veo_handoff',[s.id]);expect(h.direct_submission_authorized).toBe(true);expect(h.submitted_by).toBe(manager);expect(h.submitted_by_role).toBe('manager');expect(h.approval_mode).toBe('supervisor_submission');expect(h.evidence_photos).toHaveLength(3);}
});
it('uses the sending account role: a manager may submit for staff, while staff cannot spoof the bypass',async()=>{
 await directMode();const staff=await submit(await evidence('closed',{approval_mode:'supervisor_submission',submitted_by_role:'manager',direct_submission_authorized:true}));
 expect(staff.status).toBe('pending');expect(staff.approval_mode).toBe('supervisor_review');expect(staff.submitted_by_role).toBe('member');await expect(approve(staff,member)).rejects.toThrow('different authorized');
 const direct=await submitAs(manager,await evidence('closed',{contact_id:clientB},manager));expect(direct.status).toBe('approved');expect(direct.seller_id).toBe(member);expect(direct.submitted_by).toBe(manager);
 const checked=await approve(staff,manager);expect(checked.status).toBe('approved');expect(checked.approval_mode).toBe('supervisor_review');
});
it('keeps amount, photo and branch validation atomic for automatic manager submissions',async()=>{
 await directMode();const e=await evidence('closed',{seller_id:manager},manager);
 await expect(submitAs(manager,{...e,photos:e.photos.slice(0,2)})).rejects.toThrow('Three different');expect((await db.query('SELECT * FROM veo_deal_reviews')).rows).toHaveLength(0);
 const cd=await submitAs(manager,e),bad=await evidence('done',{seller_id:manager,order_id:cd.order_id,closed_deal_id:cd.closed_deal_id,received_now_minor:100000},manager);
 await expect(submitAs(manager,bad)).rejects.toThrow('settle the price');expect((await db.query('SELECT * FROM veo_deal_reviews')).rows).toHaveLength(1);expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);
 expect((await submitAs(manager,{...bad,data:{...bad.data,received_now_minor:70000}})).status).toBe('approved');
 await expect(submitAs(other,await evidence('closed',{},other))).rejects.toThrow('permitted contact');
});
it.each([owner,leader])('allows an authorized supervisor %s to submit for staff without separate review',async actor=>{
 await directMode();expect((await submitAs(actor,await evidence('closed',{},actor))).status).toBe('approved');
});
it('retains the old manager review requirement until the new submission policy is enabled',async()=>{
 const pending=await submitAs(manager,await evidence('closed',{seller_id:manager},manager));expect(pending.status).toBe('pending');expect((await rpc('veo_scope',[manager])).supervisor_submissions_enabled).toBe(false);
 await expect(approve(pending,manager)).rejects.toThrow('different authorized');
});
it.each([manager,member])('creates and settles a direct Done Deal for seller %s without creating a Close Deal',async seller=>{
 await directMode();
 const e=await evidence('done',{seller_id:seller,received_now_minor:100000,tip_minor:12550},seller);
 await db.query('UPDATE veo_deal_review_photos SET photo_sha256=$1 WHERE id=ANY($2)',['a'.repeat(64),e.photos]);
 const saved=await submitAs(seller,e);const done=seller===manager?saved:await approve(saved,manager);
 expect(done.status).toBe('approved');expect(done.closed_deal_id).toBeNull();
 expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(1);expect((await db.query('SELECT * FROM veo_closed_deals')).rows).toHaveLength(0);
 const payments=(await db.query<any>('SELECT kind,amount_minor FROM veo_payments')).rows;expect(payments).toHaveLength(1);expect(payments[0].kind).toBe('full');expect(Number(payments[0].amount_minor)).toBe(100000);
 const order=(await db.query<any>('SELECT paid_minor,done_at FROM veo_order_facts')).rows[0];expect(Number(order.paid_minor)).toBe(100000);expect(order.done_at).not.toBeNull();expect(Number((await db.query<any>('SELECT amount_minor FROM veo_deal_tips')).rows[0].amount_minor)).toBe(12550);
 expect((await submitAs(seller,e)).duplicate).toBe(true);expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(1);
});
it.each(['closed','done'])('accepts a shared stage/order screenshot for %s while requiring three separate evidence slots',async kind=>{
 await directMode();
 await rpc('veo_sync_telegram_groups',[owner,JSON.stringify([{chat_id:-123,name:'Sales',pages:[{id:page,matched:true}],topics:{},identities:[]}])]);
 const team=(await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1',[manager])).rows[0].id;
 await rpc('veo_telegram_group_action',[manager,'group',JSON.stringify({team_id:team,chat_id:-123,page_ids:[page]})]);await rpc('veo_telegram_group_action',[manager,'membership',JSON.stringify({user_id:manager,chat_id:-123,telegram_user_id:55})]);
 const e=await evidence(kind,{seller_id:manager,...(kind==='done'?{received_now_minor:100000}:{})},manager);
 await db.query("UPDATE veo_deal_review_photos target SET photo_sha256=source.photo_sha256 FROM veo_deal_review_photos source WHERE target.id=$1 AND source.id=$2",[e.photos[2],e.photos[0]]);
 const saved=await submitAs(manager,e);expect(saved.status).toBe('approved');expect(saved.delivery_submission).toBeTruthy();
 const h=await rpc('veo_handoff',[saved.delivery_submission]);expect(h.evidence_photos).toHaveLength(3);expect(h.receipt_kind).toBe(kind);expect(h.direct_submission_authorized).toBe(true);
 expect((await submitAs(manager,e)).duplicate).toBe(true);expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(1);
 const again=await evidence(kind,{seller_id:manager,...(kind==='done'?{received_now_minor:100000}:{})},manager);
 await db.query('UPDATE veo_deal_review_photos incoming SET photo_sha256=prior.photo_sha256 FROM veo_deal_review_photos prior WHERE prior.review_id=$1 AND incoming.id=ANY($2) AND incoming.slot=prior.slot',[saved.id,again.photos]);
 await expect(submitAs(manager,again)).rejects.toThrow('already submitted');
});

it('awards one optional incentive per order with branch guards, saved reasons, reconciliation and idempotent notices',async()=>{
 const cd=await approve(await submit(await evidence()));
 await expect(rpc('veo_incentive_save',[member,'review',cd.id,5,'Great service',0,id(seq++),true])).rejects.toThrow('Manager or Team Leader');
 await expect(rpc('veo_incentive_save',[other,'review',cd.id,5,'Great service',0,id(seq++),true])).rejects.toThrow('outside your branch');
 const request=id(seq++),args=[manager,'review',cd.id,5,'Great service',0,request,true];
 const saved=await rpc('veo_incentive_save',args);expect(Number(saved.incentive.percent)).toBe(5);expect(saved.payable).toBe(false);expect(saved.saved_reasons).toEqual(['Great service']);
 await rpc('veo_incentive_save',args);expect((await db.query('SELECT * FROM veo_incentive_notices')).rows).toHaveLength(1);
 await expect(rpc('veo_incentive_save',[manager,'review',cd.id,10,'New award',0,id(seq++),false])).rejects.toThrow('Refresh');
 const dd=await approve(await submit(await evidence('done',{order_id:cd.order_id,closed_deal_id:cd.closed_deal_id,tip_minor:10000})),leader);
 const ctx=await rpc('veo_incentive_context',[manager,'review',dd.id]);expect(Number(ctx.estimated_minor)).toBe(5000);expect(ctx.payable).toBe(true);
 const today=(await db.query<any>('SELECT veo_today() today')).rows[0].today;
 const salary=await rpc('veo_salary',[member,today]);expect(Number(salary.totals[0].incentive_minor)).toBe(5000);expect(Number(salary.totals[0].commission_minor)).toBe(Number(salary.totals[0].base_commission_minor)+5000);
 const finance=await rpc('veo_finance_days',[manager,today,today,null,member]);expect(Number(finance.days[0].totals[0].commission_minor)).toBe(Number(salary.totals[0].commission_minor));
 const calendar=(await db.query<any>('SELECT commission_minor FROM veo_calendar_order_values WHERE id=$1',[cd.order_id])).rows[0];expect(Number(calendar.commission_minor)).toBe(Number(salary.totals[0].commission_minor));
 await rpc('veo_incentive_save',[leader,'review',dd.id,0,'Award correction',1,id(seq++),false]);
 expect(Number((await rpc('veo_salary',[member,today])).totals[0].incentive_minor)).toBe(0);
 expect((await db.query('SELECT * FROM veo_salary_reconciliation WHERE user_id=$1',[member])).rows.length).toBeGreaterThan(0);
});

it('uses actual spend, defers unfunded carryover and caps funded carryover without changing completed targets',async()=>{
 await expect(rpc('veo_quota_policy',[member,member,JSON.stringify({carry_enabled:true,max_carry:10,capacity_multiplier:2,fallback_cpa_minor:10000})])).rejects.toThrow('Supervisor');
 await expect(rpc('veo_quota_policy',[other,member,null])).rejects.toThrow('outside your branch');
 await rpc('veo_quota_policy',[manager,member,JSON.stringify({carry_enabled:true,max_carry:10,capacity_multiplier:2,fallback_cpa_minor:10000})]);
 await db.query('UPDATE veo_quota_policies SET effective_from=veo_today()-1 WHERE user_id=$1',[member]);
 await db.query("INSERT INTO veo_operating_quotas(user_id,work_date,capacity,quota,basis) VALUES($1,veo_today()-1,2,2,'{}')",[member]);
 const workers=Number((await db.query<any>("SELECT count(*) n FROM veo_accounts WHERE active AND role IN('member','manager') AND veo_can_page(user_id,$1)",[page])).rows[0].n);
 await db.query("INSERT INTO veo_ad_spend_coverage VALUES($1,veo_today(),'PHP',0,0,1,now(),false,true)",[page]);
 let q=await rpc('veo_supply_target',[member,(await db.query<any>('SELECT veo_today() d')).rows[0].d,2]);expect(q).toMatchObject({quota:0,carry_remaining:2,carry_applied:0,carry_deferred:2,ad_mode:'no_spend'});
 await db.query("UPDATE veo_ad_spend_coverage SET amount_minor=$2,ad_count=1 WHERE page_id=$1",[page,40000*workers]);
 const day=(await db.query<any>('SELECT veo_today() d')).rows[0].d;
 await db.query("INSERT INTO ad_daily_spend(page_id,ad_id,account_id,spend_date,currency,account_timezone,pht_aligned,amount,checked_at) VALUES($1,'998' ,'999',veo_today(),'PHP','Asia/Manila',true,$2,now())",[page,400*workers]);
 q=await rpc('veo_supply_target',[member,day,2]);expect(q).toMatchObject({quota:4,base_quota:2,carry_applied:2,carry_deferred:0});
 await rpc('veo_target',[member,day]);await db.query('UPDATE veo_ad_spend_coverage SET amount_minor=0 WHERE page_id=$1',[page]);await db.query("UPDATE ad_daily_spend SET amount=0 WHERE ad_id='998' ");await rpc('veo_target',[member,day]);
 expect(Number((await db.query<any>('SELECT quota FROM veo_operating_quotas WHERE user_id=$1 AND work_date=veo_today()',[member])).rows[0].quota)).toBe(0);
 await db.query("UPDATE veo_ad_spend_coverage SET checked_at=now()-interval '4 hours' WHERE page_id=$1",[page]);
 q=await rpc('veo_supply_target',[member,day,2]);expect(q).toMatchObject({quota:2,supply_known:false,carry_applied:0});
 await expect(db.query('UPDATE veo_operating_quotas SET quota=0 WHERE user_id=$1 AND work_date=veo_today()-1',[member])).rejects.toThrow('read-only');
});
it('marks a successfully checked zero-spend current day provisional without declaring missing or stale data complete',async()=>{
 await db.query("INSERT INTO veo_ad_spend_coverage VALUES($1,veo_today(),'PHP',0,0,1,now(),false,true)",[page]);
 const day=(await db.query<any>('SELECT veo_today() d')).rows[0].d;
 const rows=await rpc('veo_calendar_spend',[[page],day,day]);expect(rows[0]).toMatchObject({amount_minor:0,complete:false,provisional:true});
});

it('refreshes current worker and team capacity without freezing tomorrow',async()=>{
 const refreshed=await rpc('veo_refresh_spend_quotas',[]);expect(refreshed.workers).toBeGreaterThan(0);expect(refreshed.team_workspaces).toBe(1);
 expect((await db.query('SELECT * FROM veo_team_daily_capacity WHERE work_date=veo_today()')).rows.length).toBeGreaterThan(0);
 expect((await db.query('SELECT * FROM veo_operating_quotas WHERE work_date=veo_today()+1')).rows).toHaveLength(0);
});

it('reuses prepared quotas only inside calendar planning and restores normal recalculation afterward',async()=>{
 await expect(rpc('veo_calendar_prepare',[member])).rejects.toThrow('Calendar access denied');
 expect(await rpc('veo_calendar_prepare',[owner])).toBe(true);
 expect((await db.query<any>("SELECT current_setting('veo.prepared_calendar',true) mode")).rows[0].mode).not.toBe('on');
 await db.query("INSERT INTO veo_ad_spend_coverage VALUES($1,veo_today(),'PHP',0,0,1,now(),false,true)",[page]);
 await rpc('veo_target',[member,(await db.query<any>('SELECT veo_today() d')).rows[0].d]);
 expect(Number((await db.query<any>('SELECT quota FROM veo_operating_quotas WHERE user_id=$1 AND work_date=veo_today()',[member])).rows[0].quota)).toBe(0);
});
