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
const discipline=(actor:string,action:string,data:any)=>rpc('veo_discipline_action',[actor,action,JSON.stringify(data)]);
it('allows scoped warning removal and retains its audit without warnings on supervisors',async()=>{
 const request_id=id(seq++),warning=await discipline(manager,'issue',{user_id:member,request_id,reason:'Repeated missed handover'});
 expect((await rpc('veo_workflow_warnings',[manager,member])).workers[0].warning_count).toBe(1);
 expect((await discipline(manager,'issue',{user_id:member,request_id,reason:'Repeated missed handover'})).duplicate).toBe(true);
 await discipline(leader,'remove',{user_id:member,source_key:'manual:'+request_id,reason:'Evidence corrected by the member'});
 const read=await rpc('veo_workflow_warnings',[owner,null]);
 expect(read.workers.find((p:any)=>p.id===member).warning_count).toBe(0);
 for(const supervisor of [manager,leader,owner]) expect(read.workers.find((p:any)=>p.id===supervisor).warnings).toEqual([]);
 expect((await db.query<any>('SELECT removed_by FROM veo_staff_warning_records WHERE id=$1',[warning.warning_id])).rows[0].removed_by).toBe(leader);
 expect((await db.query("SELECT * FROM veo_audit WHERE action='member_warning_removed'")).rows).toHaveLength(1);
 await expect(discipline(other,'issue',{user_id:member,request_id:id(seq++),reason:'Other branch warning'})).rejects.toThrow('branch');
 await expect(discipline(manager,'issue',{user_id:manager,request_id:id(seq++),reason:'Warn myself'})).rejects.toThrow('exempt');
});
it('automatically suspends at the chosen warning limit and blocks current access without changing salary or Page grants',async()=>{
 const day=(await db.query<any>('SELECT veo_today()::text d')).rows[0].d;
 const salary=await rpc('veo_salary',[member,day]);const grants=(await db.query('SELECT * FROM user_pages WHERE user_id=$1',[member])).rows;
 await discipline(manager,'policy',{warning_limit:2,auto_suspend:true,suspension_minutes:null});
 await discipline(manager,'issue',{user_id:member,request_id:id(seq++),reason:'First missed obligation'});
 expect(await rpc('veo_member_suspension',[member])).toBeNull();
 const result=await discipline(manager,'issue',{user_id:member,request_id:id(seq++),reason:'Second missed obligation'});
 expect(result.suspension.source).toBe('warnings');expect(result.suspension.ends_at).toBeNull();
 expect(await rpc('veo_scope',[member])).toBeNull();expect((await rpc('veo_access_context',[member])).suspension.id).toBe(result.suspension.id);
 expect(await rpc('veo_authorize_resources',[member,'[]'])).toBe(false);
 await expect(rpc('veo_action',[member,'contact',JSON.stringify({contact_id:client})])).rejects.toThrow('suspended');
 await expect(rpc('veo_deal_review_context',[member,client,member])).rejects.toThrow('suspended');
 await expect(rpc('veo_intake_action',[member,'ready',JSON.stringify({request_id:id(seq++)})])).rejects.toThrow('suspended');
 expect((await db.query('SELECT * FROM user_pages WHERE user_id=$1',[member])).rows).toEqual(grants);
 expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1',[member])).rows[0].active).toBe(true);
 const after=await rpc('veo_salary',[member,day]);for(const key of ['rate','totals','closed','done'])expect(after[key]).toEqual(salary[key]);
 await discipline(leader,'lift',{user_id:member,suspension_id:result.suspension.id,reason:'Member completed supervisor review'});
 expect((await rpc('veo_scope',[member])).user_id).toBe(member);
 await rpc('veo_refresh_discipline',[manager,member]);expect(await rpc('veo_member_suspension',[member])).toBeNull();
 expect((await rpc('veo_workflow_warnings',[manager,member])).workers[0].warning_count).toBe(0);
 await discipline(manager,'issue',{user_id:member,request_id:id(seq++),reason:'New warning after return'});
 expect(await rpc('veo_member_suspension',[member])).toBeNull();
});
it('supports timed and manual suspension with scoped early lifting, expiry and idempotent retries',async()=>{
 const request_id=id(seq++),payload={user_id:member,request_id,duration_minutes:60,reason:'Temporary conduct review'};
 const result=await discipline(manager,'suspend',payload);
 expect(result.suspension.duration_minutes).toBe(60);expect(Date.parse(result.suspension.ends_at)-Date.now()).toBeGreaterThan(3500000);
 expect((await discipline(manager,'suspend',payload)).suspension.duplicate).toBe(true);
 await expect(discipline(manager,'suspend',{...payload,duration_minutes:120})).rejects.toThrow('already used');
 await expect(discipline(other,'lift',{user_id:member,suspension_id:result.suspension.id,reason:'Outside branch'})).rejects.toThrow('branch');
 await discipline(leader,'lift',{user_id:member,suspension_id:result.suspension.id,reason:'Review completed early'});
 expect(await rpc('veo_member_suspension',[member])).toBeNull();
 const next=await discipline(leader,'suspend',{...payload,request_id:id(seq++),duration_minutes:5});
 await db.query("UPDATE veo_member_suspensions SET starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' WHERE id=$1",[next.suspension.id]);
 expect(await rpc('veo_member_suspension',[member])).toBeNull();expect((await rpc('veo_scope',[member])).user_id).toBe(member);
 expect((await discipline(manager,'suspend',{...payload,request_id:id(seq++),duration_minutes:null})).suspension.ends_at).toBeNull();
 for(const target of [manager,leader,owner])await expect(discipline(owner,'suspend',{...payload,user_id:target,request_id:id(seq++)})).rejects.toThrow('exempt');
});
it('lets a Manager set an explicit rule for their branch and denies members forged policy or lifting powers',async()=>{
 await discipline(leader,'policy',{warning_limit:1,auto_suspend:true,suspension_minutes:30});
 await discipline(manager,'policy',{warning_limit:3,auto_suspend:false,suspension_minutes:null});
 expect(await rpc('veo_member_discipline_policy',[member])).toMatchObject({supervisor_id:manager,warning_limit:3,auto_suspend:false});
 await discipline(manager,'issue',{user_id:member,request_id:id(seq++),reason:'Needs manager follow-up'});
 expect(await rpc('veo_member_suspension',[member])).toBeNull();
 await expect(discipline(member,'policy',{warning_limit:1,auto_suspend:true,suspension_minutes:1})).rejects.toThrow('access required');
 await expect(discipline(manager,'policy',{warning_limit:0,auto_suspend:true,suspension_minutes:null})).rejects.toThrow('warning limit');
 for(const fn of ['veo_discipline_action(uuid,text,jsonb)','veo_member_suspension(uuid)','veo_access_context(uuid)','veo_refresh_all_discipline()'])
 expect((await db.query<any>("SELECT has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') exposed",[fn])).rows[0].exposed).toBe(false);
});
it('removes a computed warning durably and does not recreate it on scheduled refresh',async()=>{
 await db.query("UPDATE veo_tenants SET launch_at=now()-interval '10 days' WHERE id=$1",[tenant]);
 const at=(await db.query<any>("SELECT (now()-interval '3 days')::text at")).rows[0].at;
 const closed=await approve(await submit(await evidence('closed',{occurred_at:at})));
 const key='overdue:'+closed.order_id;
 expect((await rpc('veo_workflow_warnings',[manager,member])).workers[0].warnings.some((w:any)=>w.key===key)).toBe(true);
 await discipline(manager,'remove',{user_id:member,source_key:key,reason:'Excused after reviewing the situation'});
 await rpc('veo_refresh_discipline',[manager,member]);
 expect((await rpc('veo_workflow_warnings',[manager,member])).workers[0].warnings.some((w:any)=>w.key===key)).toBe(false);
 expect((await db.query<any>('SELECT removed_at FROM veo_staff_warning_records WHERE source_key=$1',[key])).rows[0].removed_at).toBeTruthy();
});
it('suspends members from newly observed workflow warnings on the scheduled refresh without duplicate strikes',async()=>{
 await db.query("UPDATE veo_tenants SET launch_at=now()-interval '10 days' WHERE id=$1",[tenant]);
 await discipline(manager,'policy',{warning_limit:1,auto_suspend:true,suspension_minutes:60});
 const at=(await db.query<any>("SELECT (now()-interval '3 days')::text at")).rows[0].at;
 await approve(await submit(await evidence('closed',{occurred_at:at})));
 expect(await rpc('veo_member_suspension',[member])).toBeNull();
 const refreshed=await rpc('veo_refresh_all_discipline',[]);expect(refreshed.tenants[0].suspended).toBe(1);
 expect((await rpc('veo_member_suspension',[member])).source).toBe('warnings');
 const count=(await db.query<any>('SELECT count(*)::int n FROM veo_staff_warning_records WHERE user_id=$1',[member])).rows[0].n;
 await rpc('veo_refresh_all_discipline',[]);
 expect((await db.query<any>('SELECT count(*)::int n FROM veo_staff_warning_records WHERE user_id=$1',[member])).rows[0].n).toBe(count);
 await expect(discipline(manager,'issue',{user_id:member,request_id:id(seq++),reason:'Another warning during suspension'})).rejects.toThrow('Lift the current suspension');
});
it('pays every manager 40 percent below quota consistently across salary, receipts, finance and calendar',async()=>{
 await db.query("UPDATE veo_tenants SET launch_at=now()-interval '30 days' WHERE id=$1",[tenant]);
 await db.query("UPDATE veo_accounts SET enrolled_at=now()-interval '30 days'");
 await db.query("UPDATE contacts SET pipeline_stage='qualified' WHERE id IN($1,$2)",[client,clientB]);
 const today=(await db.query<any>('SELECT veo_today()::text d')).rows[0].d;
 for(const [seller,contact] of [[manager,client],[member,clientB]]){
  const order=id(seq++);
  await db.query(`INSERT INTO veo_orders(id,request_id,tenant_id,team_id,page_id,contact_id,seller_id,description,total_minor,currency,created_by)
   SELECT $1,$2,$3,id,$4,$5,$6,'Carried deposit',203,'PHP',$6 FROM veo_teams WHERE manager_id=$7`,[order,id(seq++),tenant,page,contact,seller,manager]);
  await db.query(`INSERT INTO veo_payments(request_id,order_id,kind,amount_minor,reference,occurred_at,verified_by)
   VALUES($1::uuid,$2,'deposit',100,'DEPOSIT-'||$1::uuid::text,now()-interval '1 day',$4),($3::uuid,$2,'balance',103,'BALANCE-'||$3::uuid::text,now()-interval '1 minute',$4)`,[id(seq++),order,id(seq++),seller]);
  const salary=await rpc('veo_salary',[seller,today]);
  expect(salary).toMatchObject({closed:0,done:1,rate:seller===manager?40:35,manager_immunity:seller===manager});
  const expected=seller===manager?81:71;
  expect(Number(salary.totals[0].commission_minor)).toBe(expected);
  for(const name of ['veo_finance_days','veo_salary_report']){
   const day=(await rpc(name,[owner,today,today,page,seller])).days[0];
   expect(day).toMatchObject({rate:seller===manager?40:35,manager_immunity:seller===manager});
   expect(Number(day.totals[0].commission_minor)).toBe(expected);
  }
  expect(Number((await rpc('veo_receipt_commission',[owner,seller,today])).totals[0].commission_minor)).toBe(expected);
  expect(Number((await db.query<any>('SELECT commission_minor FROM veo_calendar_order_values WHERE id=$1',[order])).rows[0].commission_minor)).toBe(expected);
  if(seller===manager){
   await db.query("INSERT INTO veo_deal_incentives(order_id,percent,reason,actor_id) VALUES($1,5,'Extra service',$2)",[order,manager]);
   expect(Number((await rpc('veo_salary',[seller,today])).totals[0].commission_minor)).toBe(91);
   expect(Number((await rpc('veo_salary_report',[owner,today,today,page,seller])).days[0].totals[0].commission_minor)).toBe(91);
   expect(Number((await db.query<any>('SELECT commission_minor FROM veo_calendar_order_values WHERE id=$1',[order])).rows[0].commission_minor)).toBe(91);
   await db.query(`INSERT INTO veo_payments(request_id,order_id,kind,amount_minor,reference,occurred_at,verified_by) VALUES($1::uuid,$2,'refund',10,'REFUND-'||$1::uuid::text,now()-interval '1 second',$3)`,[id(seq++),order,seller]);
   expect(Number((await rpc('veo_salary',[seller,today])).totals[0].commission_minor)).toBe(86);
   expect(Number((await rpc('veo_salary_report',[owner,today,today,page,seller])).days[0].totals[0].commission_minor)).toBe(86);
   expect(Number((await db.query<any>('SELECT commission_minor FROM veo_calendar_order_values WHERE id=$1',[order])).rows[0].commission_minor)).toBe(86);
  }
 }
 for(const seller of [manager,other]) expect(await rpc('veo_salary',[seller,today])).toMatchObject({rate:40,manager_immunity:true});
 expect((await rpc('veo_salary',[other,today])).totals).toEqual([]);
});

it('keeps managers active after verified departure through both Telegram membership paths and permits explicit removal',async()=>{
 await rpc('veo_sync_telegram_groups',[owner,JSON.stringify([{chat_id:-123,name:'Sales',pages:[{id:page,matched:true}],topics:{},identities:[]}])]);
 const team=(await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1',[manager])).rows[0].id;
 await rpc('veo_telegram_group_action',[manager,'group',JSON.stringify({team_id:team,chat_id:-123,page_ids:[page]})]);
 for(const [seller,tg] of [[manager,55],[member,56]]) await rpc('veo_telegram_group_action',[manager,'membership',JSON.stringify({user_id:seller,chat_id:-123,telegram_user_id:tg})]);
 const observed=(await db.query<any>("SELECT (now()+interval '1 second')::text t")).rows[0].t;
 const result=await rpc('veo_apply_telegram_observations',[tenant,JSON.stringify({tenant_id:tenant,workers:[{user_id:manager,telegram_user_id:55},{user_id:member,telegram_user_id:56}].map(p=>({...p,chat_id:-123,observed_at:observed,membership:'left',membership_confirmed:true,is_bot:false}))})]);
 expect(result.departures).toBe(1);
 expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1',[manager])).rows[0].active).toBe(true);
 expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1',[member])).rows[0].active).toBe(false);
 expect((await db.query<any>('SELECT payload FROM veo_telegram_group_states WHERE user_id=$1',[manager])).rows[0].payload.membership).toBe('left');
 await db.query('DELETE FROM veo_telegram_group_states WHERE user_id=$1',[manager]);
 await db.query('DELETE FROM veo_telegram_memberships WHERE user_id=$1',[manager]);
 await db.query('UPDATE veo_teams SET telegram_groups_managed=false,telegram_chat_id=-123 WHERE id=$1',[team]);
 await db.query('DELETE FROM veo_telegram_staff_state WHERE user_id=$1',[manager]);
 await db.query('INSERT INTO veo_staff_telegram_groups(user_id,telegram_chat_id,verified_at) VALUES($1,-123,now()) ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=-123,verified_at=now()',[manager]);
 const legacy=await rpc('veo_apply_telegram_observations',[tenant,JSON.stringify({tenant_id:tenant,workers:[{user_id:manager,telegram_user_id:55,chat_id:-123,observed_at:observed,membership:'left',membership_confirmed:true,is_bot:false}]})]);
 expect(legacy.departures).toBe(0);
 expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1',[manager])).rows[0].active).toBe(true);
 expect((await rpc('veo_offboard',[owner,manager,'Owner requested removal','supervisor'])).active).toBe(false);
});

it('exempts managers from attendance warnings and quota carryover without exempting members',async()=>{
 await db.query('UPDATE veo_teams SET telegram_chat_id=-123 WHERE manager_id=$1',[manager]);
 await db.query("UPDATE veo_tenants SET launch_at=now()-interval '30 days' WHERE id=$1",[tenant]);
 await db.query("UPDATE veo_accounts SET enrolled_at=now()-interval '30 days'");
 for(const [seller,tg] of [[manager,55],[member,56]]){
  await db.query('INSERT INTO veo_worker_mappings(user_id,telegram_user_id) VALUES($1,$2)',[seller,tg]);
  await db.query(`INSERT INTO veo_telegram_staff_state(user_id,tenant_id,telegram_chat_id,telegram_user_id,membership,observed_at,availability)
   VALUES($1,$2,-123,$3,'member',now(),jsonb_build_object('work_date',(veo_today()+1)::text,'poll_id','tomorrow','created_at',now()-interval '3 hours','has_vote',false))`,[seller,tenant,tg]);
  await db.query(`INSERT INTO veo_quota_policies(user_id,effective_from) VALUES($1,veo_today()-10) ON CONFLICT(user_id) DO UPDATE SET effective_from=veo_today()-10`,[seller]);
  await db.query("INSERT INTO veo_operating_quotas(user_id,work_date,capacity,quota,basis) VALUES($1,veo_today()-1,3,3,'{}')",[seller]);
  const supply=await rpc('veo_supply_target',[seller,(await db.query<any>('SELECT veo_today()::text d')).rows[0].d,3]);
  expect(supply.carry_remaining).toBe(seller===manager?0:3);
 }
 const workers=(await rpc('veo_workflow_warnings',[owner,null])).workers;
 expect(workers.find((w:any)=>w.id===manager).warnings.some((w:any)=>w.kind==='availability_unanswered')).toBe(false);
 expect(workers.find((w:any)=>w.id===member).warnings.some((w:any)=>w.kind==='availability_unanswered')).toBe(true);
});
it('runs performance and calendar finance reports without quota writes in a read-only transaction',async()=>{
 await db.exec('SET TRANSACTION READ ONLY');
 const day=(await db.query<any>('SELECT veo_today()::text d')).rows[0].d;
 expect((await rpc('veo_operations',[owner,day,day,null,null,'all','',0])).finance.days.length).toBeGreaterThan(0);
 expect((await rpc('veo_calendar_finance',[owner,day,day,null])).days.length).toBeGreaterThan(0);
});
it('fences duplicate quota runs and refreshes workers independently with fair, expiring leases',async()=>{
 expect(await rpc('veo_claim_background_job',['quotas',id(901)])).toBe(true);
 expect((await db.query<any>("SELECT leased_until>clock_timestamp()+interval '120 seconds' covers_http_limit FROM veo_background_job_leases WHERE job='quotas'")).rows[0].covers_http_limit).toBe(true);
 expect(await rpc('veo_claim_background_job',['quotas',id(902)])).toBe(false);
 await rpc('veo_release_background_job',['quotas',id(901)]);
 await expect(rpc('veo_claim_quota_refresh',[5])).rejects.toThrow('Invalid');
 const first=await rpc('veo_claim_quota_refresh',[2]),second=await rpc('veo_claim_quota_refresh',[2]);
 expect(first).toHaveLength(2);expect(second).toHaveLength(1);expect(new Set([...first,...second].map((j:any)=>j.user_id)).size).toBe(3);
 await expect(rpc('veo_refresh_worker_quota',[first[0].user_id,id(903)])).rejects.toThrow('lease lost');
 const result=await rpc('veo_refresh_worker_quota',[first[0].user_id,first[0].lease_token]);expect(result.ok).toBe(true);
 await expect(rpc('veo_refresh_worker_quota',[first[0].user_id,first[0].lease_token])).rejects.toThrow('lease lost');
 await db.query("UPDATE veo_quota_refresh_state SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=$1",[first[1].user_id]);
 const retry=(await rpc('veo_claim_quota_refresh',[1]))[0];expect(retry.user_id).toBe(first[1].user_id);expect(retry.lease_token).not.toBe(first[1].lease_token);
 await db.query('UPDATE users SET is_active=false WHERE id=$1',[retry.user_id]);expect(await rpc('veo_refresh_worker_quota',[retry.user_id,retry.lease_token])).toMatchObject({ok:true,skipped:true});
 await db.query("UPDATE veo_quota_refresh_state SET last_work_date=veo_today()-1,next_attempt_at=clock_timestamp()+interval '1 hour' WHERE user_id=$1",[first[0].user_id]);
 expect((await rpc('veo_claim_quota_refresh',[1]))[0].user_id).toBe(first[0].user_id);
 for(const signature of ['veo_claim_quota_refresh(integer)','veo_refresh_worker_quota(uuid,uuid)','veo_connection_safety()'])expect((await db.query<any>("SELECT has_function_privilege('authenticated',$1,'EXECUTE') exposed",[signature])).rows[0].exposed).toBe(false);
});
it('processes a bounded reconciliation batch without recalculating current-day quotas',async()=>{
 await db.query("UPDATE veo_tenants SET launch_at=now()-interval '30 days' WHERE id=$1",[tenant]);
 await db.query("UPDATE veo_accounts SET enrolled_at=now()-interval '30 days'");
 await db.query('INSERT INTO veo_salary_reconciliation(user_id,work_date) SELECT $1,veo_today()-n FROM generate_series(1,12) n ON CONFLICT DO NOTHING',[member]);
 await db.query("INSERT INTO veo_salary_reconciliation(user_id,work_date) SELECT user_id,veo_today()-1 FROM veo_accounts WHERE active AND role IN('member','manager') ON CONFLICT DO NOTHING");
 const count=async()=>Number((await db.query<any>('SELECT count(*) n FROM veo_salary_reconciliation')).rows[0].n);
 const before=await count();expect(before).toBeGreaterThan(10);await rpc('veo_maintenance',[]);expect(await count()).toBe(before-10);
 await rpc('veo_maintenance',[]);expect(await count()).toBe(0);
});
it('rolls back a slow worker update and backs it off so other quota updates can still commit',async()=>{
 const jobs=await rpc('veo_claim_quota_refresh',[4]),job=jobs.find((j:any)=>j.user_id===member),otherJob=jobs.find((j:any)=>j.user_id!==member);
 const before=(await db.query<any>('SELECT target FROM veo_daily_targets WHERE user_id=$1 AND work_date=veo_today()',[member])).rows[0].target;
 await db.exec(`ALTER FUNCTION veo_target(uuid,date) RENAME TO veo_target_timeout_fixture;
 CREATE FUNCTION veo_target(p_user uuid,p_day date) RETURNS integer LANGUAGE plpgsql AS $$BEGIN
 IF p_user='${member}'::uuid THEN UPDATE veo_daily_targets SET target=target+99 WHERE user_id=p_user AND work_date=p_day;RAISE EXCEPTION 'Simulated deadline' USING ERRCODE='57014';END IF;
 RETURN veo_target_timeout_fixture(p_user,p_day);END $$;`);
 expect(await rpc('veo_refresh_worker_quota',[job.user_id,job.lease_token])).toMatchObject({ok:false,overloaded:true});
 expect((await db.query<any>('SELECT target FROM veo_daily_targets WHERE user_id=$1 AND work_date=veo_today()',[member])).rows[0].target).toBe(before);
 expect((await db.query<any>("SELECT last_error_code,next_attempt_at>clock_timestamp()+interval '9 minutes' backed_off FROM veo_quota_refresh_state WHERE user_id=$1",[member])).rows[0]).toEqual({last_error_code:'57014',backed_off:true});
 expect((await rpc('veo_refresh_worker_quota',[otherJob.user_id,otherJob.lease_token])).ok).toBe(true);
});
it('serves salary from recorded quotas in a read-only transaction without running planning writes',async()=>{
 await db.exec('SET TRANSACTION READ ONLY');
 const day=(await db.query<any>('SELECT veo_today()::text AS work_date')).rows[0].work_date;
 const report=await rpc('veo_salary_report',[owner,day,day,null,null]);expect(report.days.length).toBeGreaterThan(0);
 expect(report.days.every((d:any)=>d.work_date===day)).toBe(true);
});
it('preserves salary math, employee and Page scope using the same verified ledger and rejects missing current quota snapshots',async()=>{
 const closed=await approve(await submit(await evidence()));await approve(await submit(await evidence('done',{order_id:closed.order_id,closed_deal_id:closed.closed_deal_id})));
 const day=(await db.query<any>('SELECT veo_today()::text AS work_date')).rows[0].work_date;
 const expected=await rpc('veo_finance_days',[owner,day,day,page,member]);
 const snapshot=async()=> (await db.query<any>("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY user_id,work_date)::text) hash FROM veo_daily_targets t")).rows[0].hash;
 const before=await snapshot();expect(await rpc('veo_salary_report',[owner,day,day,page,member])).toEqual(expected);expect(await snapshot()).toBe(before);
 await expect(rpc('veo_salary_report',[other,day,day,page,member])).rejects.toThrow('Forbidden');
 await db.query('DELETE FROM veo_daily_targets WHERE user_id=$1 AND work_date=$2',[member,day]);await expect(rpc('veo_salary_report',[owner,day,day,page,member])).rejects.toThrow('snapshots are still being prepared');
 expect((await db.query<any>("SELECT has_function_privilege('authenticated','veo_salary_report(uuid,date,date,uuid,uuid)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
});
it('clears old overdue projects only after approved Done Deal evidence and preserves pending reviews and financial history',async()=>{
 await db.query("UPDATE veo_tenants SET launch_at=now()-interval '10 days' WHERE id=$1",[tenant]);
 const at=(await db.query<any>("SELECT (now()-interval '3 days')::text at")).rows[0].at;
 const closed=await approve(await submit(await evidence('closed',{occurred_at:at})));
 const fact=async()=> (await db.query<any>('SELECT overdue,overdue_hours,verified_done_deal FROM veo_work_facts WHERE id=$1',[closed.order_id])).rows[0];
 expect(await fact()).toMatchObject({overdue:true,verified_done_deal:false});
 const pending=await submit(await evidence('done',{order_id:closed.order_id,closed_deal_id:closed.closed_deal_id}));
 expect(await fact()).toMatchObject({overdue:true,verified_done_deal:false});
 const done=await approve(pending);expect(done.delivery_status).toBe('waiting_for_telegram_setup');
 expect(await fact()).toMatchObject({overdue:false,verified_done_deal:true});expect(Number((await fact()).overdue_hours)).toBe(0);
 const warnings=await rpc('veo_workflow_warnings',[owner,member]);
 expect(warnings.workers.flatMap((w:any)=>w.warnings).some((w:any)=>w.kind==='overdue_without_reason'&&w.order_id===closed.order_id)).toBe(false);
 expect((await db.query('SELECT * FROM veo_payments WHERE order_id=$1',[closed.order_id])).rows).toHaveLength(2);
 // Payment alone is not proof of completed production, even with a Close receipt.
 await db.query("UPDATE veo_deal_reviews SET status='rejected' WHERE id=$1",[done.id]);
 expect(await fact()).toMatchObject({overdue:true,verified_done_deal:false});
 const submission=id(seq++);await db.query("INSERT INTO veo_submissions(id,order_id,submitted_by,object_path,expires_at,receipt_kind,status) VALUES($1,$2,$3,'legacy',now()+interval '1 day','closed','delivered')",[submission,closed.order_id,member]);
 expect(await fact()).toMatchObject({overdue:true,verified_done_deal:false});
 await db.query("UPDATE veo_submissions SET receipt_kind='done' WHERE id=$1",[submission]);
 expect(await fact()).toMatchObject({overdue:false,verified_done_deal:true});
});
it('keeps login credentials service-only, normalizes stored emails, rate limits and rejects inactive or ambiguous identities',async()=>{
 const email=member+'@example.com';
 await db.query('UPDATE users SET email=$2 WHERE id=$1',[member,' '+email.toUpperCase()+' ']);
 const context=await rpc('veo_login_context',[email]);expect(context).toMatchObject({id:member,password_hash:stored});
 expect(Object.keys(context).sort()).toEqual(['email','id','image','name','password_hash']);
 const key="encode(sha256(convert_to($1,'UTF8')),'hex')";
 await db.query(`UPDATE veo_login_limits SET attempts=10 WHERE key=${key}`,[email]);expect(await rpc('veo_login_context',[email])).toEqual({limited:true});
 expect((await db.query<any>(`SELECT attempts FROM veo_login_limits WHERE key=${key}`,[email])).rows[0].attempts).toBe(11);
 await db.query('DELETE FROM veo_login_limits');
 await db.query('UPDATE users SET is_active=false WHERE id=$1',[member]);expect(await rpc('veo_login_context',[email])).toBeNull();
 await db.query('UPDATE users SET is_active=true WHERE id=$1',[member]);await db.query('UPDATE veo_accounts SET active=false WHERE user_id=$1',[member]);expect(await rpc('veo_login_context',[email])).toBeNull();
 await db.query('UPDATE veo_accounts SET active=true WHERE user_id=$1',[member]);await db.query('UPDATE users SET email=$2 WHERE id=$1',[other,email]);
 await expect(rpc('veo_login_context',[email])).rejects.toThrow('Ambiguous account');
 expect((await db.query<any>("SELECT has_function_privilege('anon','veo_login_context(text)','EXECUTE') anon,has_function_privilege('authenticated','veo_login_context(text)','EXECUTE') authenticated,has_function_privilege('service_role','veo_login_context(text)','EXECUTE') service")).rows[0]).toEqual({anon:false,authenticated:false,service:true});
});
it('rotates stage audits through known contacts using fenced Page leases and keeps a failed read retryable',async()=>{
 await db.query('UPDATE pages SET messaging_auto_tag_enabled=true WHERE id=$1',[page]);
 const claim=async()=>{await db.query("UPDATE veo_autotag_page_state SET next_attempt_at=now()-interval '1 minute' WHERE page_id=$1",[page]);return (await rpc('veo_claim_autotag_pages',[1]))[0];};
 const first=await claim();const audit=await rpc('veo_autotag_audit_contact',[page,first.lease_token]);expect(audit.id).toBe(client);
 await expect(rpc('veo_autotag_audit_contact',[page,id(999)])).rejects.toThrow('lease lost');
 expect(await rpc('veo_finish_autotag_page',[page,first.lease_token,JSON.stringify({error:'META_READ_UNAVAILABLE',audit_contact:audit.id})])).toBe(true);
 const retry=await claim();expect((await rpc('veo_autotag_audit_contact',[page,retry.lease_token])).id).toBe(client);
 expect(await rpc('veo_finish_autotag_page',[page,first.lease_token,JSON.stringify({audit_contact:audit.id})])).toBe(false);
 expect(await rpc('veo_finish_autotag_page',[page,retry.lease_token,JSON.stringify({audit_contact:audit.id})])).toBe(true);
 const next=await claim();expect((await rpc('veo_autotag_audit_contact',[page,next.lease_token])).id).toBe(clientB);
 await rpc('veo_finish_autotag_page',[page,next.lease_token,JSON.stringify({audit_contact:clientB})]);
 const wrap=await claim();expect((await rpc('veo_autotag_audit_contact',[page,wrap.lease_token])).id).toBe(client);
 expect((await db.query<any>("SELECT has_function_privilege('authenticated','veo_autotag_audit_contact(uuid,uuid)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
});
it('returns the same dashboard financial figures without unused list hydration and preserves the full report',async()=>{
 const closed=await approve(await submit(await evidence()));
 await approve(await submit(await evidence('done',{order_id:closed.order_id,closed_deal_id:closed.closed_deal_id})));
 const day=(await db.query<any>('SELECT veo_today()::text AS work_date')).rows[0].work_date;
 const full=await rpc('veo_dashboard',[owner,day]);expect(full.orders.length).toBeGreaterThan(0);expect(full.sync.length).toBeGreaterThan(0);
 const summary=await rpc('veo_dashboard_summary',[owner,day]);
 expect(summary).toEqual({...full,orders:[],sync:[]});
 expect((await rpc('veo_dashboard',[owner,day])).orders).toEqual(full.orders);
 const personal=await rpc('veo_dashboard_summary',[member,day]);
 expect(personal.accounts.every((a:any)=>a.id===member)).toBe(true);expect(personal.salary.every((s:any)=>s.user_id===member)).toBe(true);
 await expect(rpc('veo_dashboard_summary',[id(999),day])).rejects.toThrow('Forbidden');
 expect((await db.query<any>("SELECT has_function_privilege('anon','veo_dashboard_summary(uuid,date)','EXECUTE') anon,has_function_privilege('authenticated','veo_dashboard_summary(uuid,date)','EXECUTE') authenticated,has_function_privilege('service_role','veo_dashboard_summary(uuid,date)','EXECUTE') service")).rows[0]).toEqual({anon:false,authenticated:false,service:true});
});
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
it('preserves approved receipt and salary history when delivered evidence photos are removed',async()=>{
 const cd=await approve(await submit(await evidence()));
 const dd=await approve(await submit(await evidence('done',{order_id:cd.order_id,closed_deal_id:cd.closed_deal_id,tip_minor:5000})));
 const day=(await db.query<any>('SELECT veo_today()::text d')).rows[0].d;
 const salary=await rpc('veo_salary',[member,day]);
 const ledger=async()=>({orders:(await db.query('SELECT * FROM veo_orders ORDER BY id')).rows,payments:(await db.query('SELECT * FROM veo_payments ORDER BY id')).rows,tips:(await db.query('SELECT * FROM veo_deal_tips ORDER BY review_id')).rows,audit:(await db.query('SELECT * FROM veo_audit ORDER BY id')).rows});
 const before=await ledger();
 await db.query('UPDATE veo_photo_objects SET deleted_at=clock_timestamp() WHERE object_path IN(SELECT object_path FROM veo_deal_review_photos WHERE review_id=ANY($1::uuid[]))',[[cd.id,dd.id]]);
 for(const receipt of [cd,dd]){
  const review=await rpc('veo_deal_review_access',[member,receipt.id]);expect(review.status).toBe('approved');expect(review.deleted_at).toBeNull();
  expect(review.photos).toHaveLength(3);expect(review.photos.every((p:any)=>p.available===false)).toBe(true);
 }
 expect(await ledger()).toEqual(before);expect(await rpc('veo_salary',[member,day])).toEqual(salary);
 for(const constraint of ['veo_deal_review_photos_review_id_fkey','veo_deal_reviews_delivery_submission_fkey'])expect((await db.query('SELECT 1 FROM pg_constraint WHERE conname=$1',[constraint])).rows).toHaveLength(1);
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
it.each([manager,leader])('commits staff milestones before their scheduled automatic approval',async actor=>{
 await rpc('veo_team_auto_approval_setting',[actor,true]);
 const saved=await submit(await evidence());expect(saved.status).toBe('pending');expect(saved.auto_approval_pending).toBe(true);
 expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(0);
 expect((await rpc('veo_auto_approve_pending_team_reviews',[20,actor])).approved).toBe(1);
 const cd=await rpc('veo_deal_review_access',[member,saved.id]);expect(cd.status).toBe('approved');expect(cd.auto_approved).toBe(true);expect(cd.reviewed_by).toBe(actor);
 const next=await submit(await evidence('done',{order_id:cd.order_id,closed_deal_id:cd.closed_deal_id}));expect(next.status).toBe('pending');
 expect((await rpc('veo_auto_approve_pending_team_reviews',[20,actor])).approved).toBe(1);
 const dd=await rpc('veo_deal_review_access',[member,next.id]);expect(dd.status).toBe('approved');expect(dd.auto_approved).toBe(true);
 expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(2);
});
it('keeps a staff receipt pending when team auto-approval cannot settle its linked order',async()=>{
 const cd=await approve(await submit(await evidence()));
 await rpc('veo_team_auto_approval_setting',[manager,true]);
 const e=await evidence('done',{order_id:cd.order_id,closed_deal_id:cd.closed_deal_id,received_now_minor:100000});
 const saved=await submit(e);
 expect(saved.status).toBe('pending');expect(saved.auto_approval_pending).toBe(true);
 expect((await rpc('veo_auto_approve_pending_team_reviews',[20,manager])).needs_review).toBe(1);
 expect((await rpc('veo_deal_review_access',[member,saved.id])).auto_approval_error).toContain('Review this submission');
 expect(saved.auto_approved).toBe(false);expect(saved.delivery_submission).toBeNull();
 expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);
 expect((await db.query('SELECT * FROM veo_deal_reviews')).rows).toHaveLength(2);
 expect((await rpc('veo_deal_review_access',[manager,saved.id])).photos).toHaveLength(3);
 expect(await submit(e)).toMatchObject({id:saved.id,status:'pending',duplicate:true});
 await expect(approve(saved)).rejects.toThrow('settle the price');
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

it('corrects inquiry dates only after complete history, rejects stale leases and audits the earlier message',async()=>{
 const lease=id(seq++),older='2026-08-01T22:27:29Z',later='2026-11-13T00:05:30Z';
 await db.query("INSERT INTO ad_contact_sources(contact_id,page_id,first_inquiry_at,first_message_id,inquiry_basis,origin_ad_id,origin_evidence_key,attribution_status) VALUES($1,$2,$3,'recent','live_message','123','old-ad','verified_inline')",[client,page,later]);
 await db.query("UPDATE veo_inquiry_history_jobs SET lease_token=$2,lease_until=now()+interval '2 minutes' WHERE contact_id=$1",[client,lease]);
 expect((await rpc('veo_finish_inquiry_history',[client,id(seq++),null,older,'original',true,null])).saved).toBe(false);
 const partial=await rpc('veo_finish_inquiry_history',[client,lease,'https://graph.facebook.com/v24.0/thread/messages?after=older',older,'original',false,null]);expect(partial.complete).toBe(false);
 expect((await db.query<any>('SELECT inquiry_basis FROM ad_contact_sources WHERE contact_id=$1',[client])).rows[0].inquiry_basis).toBe('live_message');
 await db.query("UPDATE veo_inquiry_history_jobs SET lease_token=$2,lease_until=now()+interval '2 minutes' WHERE contact_id=$1",[client,lease]);
 const done=await rpc('veo_finish_inquiry_history',[client,lease,null,older,'original',true,null]);expect(done).toMatchObject({complete:true,changed:true});
 const source=(await db.query<any>('SELECT * FROM ad_contact_sources WHERE contact_id=$1',[client])).rows[0];expect(source.inquiry_basis).toBe('verified_history');expect(source.first_message_id).toBe('original');expect(source.origin_ad_id).toBeNull();
 expect((await db.query<any>("SELECT count(*) n FROM veo_audit WHERE action='inquiry_history_verified'")).rows[0].n).toBe(1);
 expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);
 expect((await rpc('veo_finish_inquiry_history',[client,null,null,older,'original',true,null])).saved).toBe(false);
});
it('retains an earlier saved inquiry when the accessible history starts later',async()=>{
 const lease=id(seq++);await db.query("INSERT INTO ad_contact_sources(contact_id,page_id,first_inquiry_at,first_message_id,inquiry_basis) VALUES($1,$2,'2025-01-01','original','verified_history')",[client,page]);
 await db.query("UPDATE veo_inquiry_history_jobs SET lease_token=$2,lease_until=now()+interval '2 minutes' WHERE contact_id=$1",[client,lease]);
 const result=await rpc('veo_finish_inquiry_history',[client,lease,null,'2026-01-01','later',true,null]);expect(result.complete).toBe(false);expect(result.error).toContain('original date retained');
 expect((await db.query<any>('SELECT first_message_id FROM ad_contact_sources WHERE contact_id=$1',[client])).rows[0].first_message_id).toBe('original');
});
