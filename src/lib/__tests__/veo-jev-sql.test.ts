import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { schemaMigrationPlan } from '../../../scripts/lib/database-migration-safety.mjs';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let db:PGlite,tenant:string,transactionalTest=false;
const rpc=async(name:string,args:unknown[])=>(await db.query<any>(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS r`,args)).rows[0].r;
beforeAll(async()=>{
 db=await PGlite.create({extensions:{'uuid-ossp':uuid_ossp,pg_trgm,vector}});
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA extensions;CREATE SCHEMA cron;
 CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text);CREATE TABLE cron.job_run_details(end_time timestamptz);
 CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS 'INSERT INTO cron.job(jobname) VALUES($1) RETURNING jobid';
 CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobid=$1 RETURNING true';`);
 for(const m of schemaMigrationPlan())await db.exec(m.sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;/g,'-- scheduler stub'));
 await db.query("INSERT INTO users(id,email,name) VALUES($1,'owner@example.com','CJ Lara')",[id(1)]);
 await db.query("INSERT INTO pages(id,fb_page_id,name,access_token) VALUES($1,'base','VEO','test')",[id(2)]);
 await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)',[id(1),id(2)]);
 tenant=await rpc('veo_launch',[id(1),[id(2)]]);
 await db.query('INSERT INTO veo_jev_policy(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',[tenant]);
},60000);
afterAll(async()=>{await db?.close();});
describe('Jev interruption review ownership and snapshot checks',()=>{
    const reviewPage=id(986),reviewContact=id(987),stateId=id(988);
    const claim=async()=>(await db.query<any>('SELECT * FROM veo_claim_jev_reviews($1)',[2])).rows[0];
    const apply=(job:any,action='resume',confidence=.99)=>rpc('veo_apply_jev_review',[job.id,job.attempt,JSON.stringify({action,confidence,wait_minutes:5,reason:'Customer remains interested',customer_evidence:'Please follow up',history_verified:true})]);
    beforeEach(async()=>{
        await db.exec('BEGIN');transactionalTest=true;
        await db.query("INSERT INTO pages(id,fb_page_id,name,access_token,veo_tenant_id,veo_enabled) VALUES($1,'jev-review-page','Jev Page','test',$2,true)",[reviewPage,tenant]);
        await db.query("INSERT INTO chatbot_configs(page_id,enabled,follow_up_enabled,instructions) VALUES($1,true,true,'Keep customer details')",[reviewPage]);
        await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage,pipeline_stage_source,last_inbound_at,chatbot_enabled) VALUES($1,$2,'jev-customer','Customer','engaged','chatbot',now()-interval '20 minutes',true)",[reviewContact,reviewPage]);
        await db.query("INSERT INTO chatbot_contact_states(id,page_id,contact_id,status,stop_reason,pause_kind,started_at,stopped_at,last_human_activity_at,window_expires_at,collected_details) VALUES($1,$2,$3,'stopped','manual','human_takeover',now()-interval '1 hour',now()-interval '10 minutes',now()-interval '10 minutes',now()+interval '1 day',$4::jsonb)",[stateId,reviewPage,reviewContact,JSON.stringify({business:'Bakery'})]);
        await db.query("UPDATE veo_jev_policy SET enabled=true,model_id='example/jev',mode='active',activated_at=now()-interval '1 hour',updated_at=now() WHERE tenant_id=$1",[tenant]);
    });
    afterEach(async()=>{transactionalTest=false;await db.exec('ROLLBACK');});
    it('keeps a waiting conversation paused, preserves answers and schedules a later review',async()=>{
        const job=await claim();expect(job.model_id).toBe('example/jev');expect(await apply(job,'wait')).toBe(true);
        const state=(await db.query<any>('SELECT status,collected_details FROM chatbot_contact_states WHERE id=$1',[stateId])).rows[0];
        expect(state).toMatchObject({status:'stopped',collected_details:{business:'Bakery'}});
        expect((await db.query<any>('SELECT status,attempt,due_at>now() future FROM veo_jev_reviews WHERE id=$1',[job.id])).rows[0]).toMatchObject({status:'wait',attempt:0,future:true});
    });
    it.each(['manual_bot_off','explicit_hold','new_human_activity','new_customer_message','model_changed'])('rejects a decision after %s changes',async(change)=>{
        const job=await claim();
        if(change==='manual_bot_off')await db.query('UPDATE contacts SET chatbot_enabled=false WHERE id=$1',[reviewContact]);
        if(change==='explicit_hold')await db.query("UPDATE chatbot_contact_states SET pause_kind='explicit_hold' WHERE id=$1",[stateId]);
        if(change==='new_human_activity')await db.query('UPDATE chatbot_contact_states SET last_human_activity_at=clock_timestamp() WHERE id=$1',[stateId]);
        if(change==='new_customer_message')await db.query('UPDATE contacts SET last_inbound_at=clock_timestamp() WHERE id=$1',[reviewContact]);
        if(change==='model_changed')await db.query("UPDATE veo_jev_policy SET model_id='other/model',updated_at=clock_timestamp() WHERE tenant_id=$1",[tenant]);
        expect(await apply(job)).toBe(false);
        expect((await db.query<any>('SELECT status FROM chatbot_contact_states WHERE id=$1',[stateId])).rows[0].status).toBe('stopped');
        expect((await db.query('SELECT id FROM chatbot_follow_up_jobs WHERE contact_id=$1',[reviewContact])).rows).toHaveLength(0);
    });
    it('resumes future replies without sending a message or changing collected customer details',async()=>{
        const job=await claim();expect(await apply(job)).toBe(true);
        expect((await db.query<any>('SELECT status,pause_kind,collected_details FROM chatbot_contact_states WHERE id=$1',[stateId])).rows[0]).toMatchObject({status:'active',pause_kind:null,collected_details:{business:'Bakery'}});
        expect((await db.query('SELECT id FROM chatbot_follow_up_jobs WHERE contact_id=$1',[reviewContact])).rows).toHaveLength(0);
    });
    it('records Jev decisions without changing chatbot behavior in observation mode',async()=>{
        await db.query("UPDATE veo_jev_policy SET mode='observe' WHERE tenant_id=$1",[tenant]);
        const job=await claim();expect(await apply(job,'resume')).toBe(true);
        expect((await db.query<any>('SELECT status,pause_kind FROM chatbot_contact_states WHERE id=$1',[stateId])).rows[0]).toMatchObject({status:'stopped',pause_kind:'human_takeover'});
        expect((await db.query<any>("SELECT status,decision->>'action' AS action FROM veo_jev_reviews WHERE id=$1",[job.id])).rows[0]).toEqual({status:'observed',action:'resume'});
    });
    it('queues a contextual follow-up once through the ordinary delivery worker',async()=>{
        const job=await claim();expect(await apply(job,'follow_up')).toBe(true);expect(await apply(job,'follow_up')).toBe(false);
        const jobs=(await db.query<any>('SELECT purpose,due_at>now() future FROM chatbot_follow_up_jobs WHERE contact_id=$1',[reviewContact])).rows;
        expect(jobs).toEqual([{purpose:'jev_continuation',future:true}]);
    });
    it('keeps low-confidence reviews paused and does not run with no configured model',async()=>{
        const job=await claim();expect(await apply(job,'resume',.6)).toBe(true);
        expect((await db.query<any>('SELECT status FROM chatbot_contact_states WHERE id=$1',[stateId])).rows[0].status).toBe('stopped');
        await db.query('UPDATE veo_jev_policy SET enabled=false,model_id=NULL WHERE tenant_id=$1',[tenant]);
        for(const table of ['veo_jev_policy','veo_jev_reviews'])expect((await db.query<any>("SELECT has_table_privilege('anon',$1,'SELECT') OR has_table_privilege('authenticated',$1,'SELECT') exposed",[table])).rows[0].exposed).toBe(false);
        await expect(db.query('UPDATE veo_jev_policy SET enabled=true,model_id=NULL WHERE tenant_id=$1',[tenant])).rejects.toThrow();
    });
});
