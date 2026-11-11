import { afterAll, beforeAll, beforeEach, afterEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { schemaMigrationPlan } from '../../../scripts/lib/database-migration-safety.mjs';
import { createHash } from 'node:crypto';import { hashSync, compareSync } from 'bcryptjs';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner=id(1),leader=id(4),manager=id(5),member=id(6),other=id(7),page=id(2),pageB=id(3);
const stored='veo-sha256:'+hashSync(createHash('sha256').update('test password').digest('base64'),4);
let db:PGlite,tenant:string;const rpc=async(name:string,args:any[])=>{
 await db.exec('SAVEPOINT operation');try{const r=(await db.query<any>(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;await db.exec('RELEASE SAVEPOINT operation');return r;}
 catch(e){await db.exec('ROLLBACK TO SAVEPOINT operation;RELEASE SAVEPOINT operation');throw e;}
};
const action=(actor:string,kind:string,data:any)=>rpc('veo_action',[actor,kind,JSON.stringify(data)]);
beforeAll(async()=>{
 db=await PGlite.create({extensions:{'uuid-ossp':uuid_ossp,pg_trgm,vector}});
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA extensions;CREATE SCHEMA cron;
 CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text);CREATE TABLE cron.job_run_details(end_time timestamptz);
 CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS 'INSERT INTO cron.job(jobname) VALUES($1) RETURNING jobid';
 CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobid=$1 RETURNING true';`);
 const plan=schemaMigrationPlan();for(const m of plan.filter(m=>m.name<'202611110005_'))await db.exec(m.sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;/g,'-- scheduler stub'));
 await db.query("INSERT INTO users(id,email,name,password_hash) VALUES($1,'owner@example.com','Owner',$2)",[owner,stored]);
 for(const [p,fb] of [[page,'111'],[pageB,'222']])await db.query('INSERT INTO pages(id,fb_page_id,name,access_token) VALUES($1,$2,$2,\'test\')',[p,fb]);
 await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2),($1,$3)',[owner,page,pageB]);tenant=(await db.query<any>('SELECT veo_launch($1,$2) t',[owner,[page,pageB]])).rows[0].t;
 const create=async(actor:string,user:string,parent:string,role:string)=>{await db.query('SELECT veo_action($1,\'create_account\',$2)',[actor,JSON.stringify({user_id:user,parent_id:parent,role,name:role,email:user+'@example.com',password_hash:stored,page_ids:[page,pageB]})]);};
 await create(owner,leader,owner,'team_leader');await create(leader,manager,leader,'manager');await create(manager,member,manager,'member');await create(owner,other,owner,'manager');
 await db.query('DELETE FROM veo_teams WHERE manager_id=$1',[leader]);const teams=(await db.query('SELECT * FROM veo_teams ORDER BY id')).rows,grants=(await db.query('SELECT * FROM user_pages ORDER BY user_id,page_id')).rows;
 await db.query("INSERT INTO veo_attendance(user_id,work_date,active,updated_by) SELECT user_id,veo_today(),true,$1 FROM veo_accounts WHERE role IN('manager','member')",[owner]);
 const capacity=(await db.query<any>('SELECT veo_team_capacity($1,veo_today()) p',[owner])).rows[0].p;expect(capacity.combined.quota.closed).toBeGreaterThan(0);
 await db.exec(plan.find(m=>m.name.startsWith('202611110005_'))!.sql);
 await db.exec(plan.find(m=>m.name.startsWith('202611110006_'))!.sql);
 await db.exec(plan.find(m=>m.name.startsWith('202611110007_'))!.sql);
 expect((await db.query('SELECT * FROM veo_teams WHERE manager_id<>$1 ORDER BY id',[leader])).rows).toEqual(teams);expect((await db.query('SELECT * FROM user_pages ORDER BY user_id,page_id')).rows).toEqual(grants);
 expect((await db.query('SELECT * FROM veo_teams WHERE manager_id=$1',[leader])).rows).toHaveLength(1);
 const afterCapacity=(await db.query<any>('SELECT veo_team_capacity($1,veo_today()) p',[owner])).rows[0].p;
 expect(afterCapacity.combined.quota).toEqual(capacity.combined.quota);expect(afterCapacity.combined.workers).toEqual(capacity.combined.workers);
},60000);
afterAll(async()=>{await db?.close();});beforeEach(async()=>{await db.exec('BEGIN');});afterEach(async()=>{await db.exec('ROLLBACK');});
it('moves an existing member directly under their Team Leader without changing any login, Page assignment or recorded financial row',async()=>{
 const before=(await db.query('SELECT id,email,password_hash,is_active FROM users ORDER BY id')).rows,grants=(await db.query('SELECT * FROM user_pages ORDER BY user_id,page_id')).rows;
 const changed=await rpc('veo_change_member_supervisor',[leader,member,leader,manager]);expect(changed).toMatchObject({id:member,parent_id:leader,credentials_unchanged:true,page_assignments_unchanged:true});
 expect((await db.query<any>('SELECT parent_id FROM veo_accounts WHERE user_id=$1',[member])).rows[0].parent_id).toBe(leader);
 expect((await db.query('SELECT id,email,password_hash,is_active FROM users ORDER BY id')).rows).toEqual(before);expect((await db.query('SELECT * FROM user_pages ORDER BY user_id,page_id')).rows).toEqual(grants);
 const login=(await db.query<any>('SELECT password_hash FROM users WHERE id=$1',[member])).rows[0];expect(compareSync(createHash('sha256').update('test password').digest('base64'),login.password_hash.slice(11))).toBe(true);
 await expect(rpc('veo_change_member_supervisor',[owner,member,manager,manager])).rejects.toThrow('Supervisor changed');
 await expect(rpc('veo_change_member_supervisor',[owner,member,manager,manager])).rejects.toMatchObject({code:'23505'});
 expect((await db.query<any>("SELECT proconfig FROM pg_proc WHERE oid='veo_change_member_supervisor(uuid,uuid,uuid,uuid)'::regprocedure")).rows[0].proconfig).toContain('jit=off');
 expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(0);expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);
});
it('rejects out-of-branch, lower-role and Page-losing supervisor changes',async()=>{
 await expect(rpc('veo_change_member_supervisor',[other,member,other,manager])).rejects.toThrow('Owner or Team Leader');
 await expect(rpc('veo_change_member_supervisor',[leader,member,other,manager])).rejects.toThrow('within your branch');
 await expect(rpc('veo_change_member_supervisor',[owner,member,member,manager])).rejects.toThrow('within your branch');
 await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2',[other,pageB]);await expect(rpc('veo_change_member_supervisor',[owner,member,other,manager])).rejects.toThrow('assigned Pages');
 expect((await db.query<any>('SELECT parent_id FROM veo_accounts WHERE user_id=$1',[member])).rows[0].parent_id).toBe(manager);
 expect((await db.query<any>("SELECT has_function_privilege('authenticated','veo_change_member_supervisor(uuid,uuid,uuid,uuid)','EXECUTE') allowed")).rows[0].allowed).toBe(false);
});
it('reports real setup and cooldown states only to the Owner without returning hashes',async()=>{
 await db.query('UPDATE users SET email=NULL,password_hash=NULL,is_active=false WHERE id=$1',[leader]);await db.query('UPDATE users SET password_hash=NULL WHERE id=$1',[manager]);
 const key=createHash('sha256').update(member+'@example.com').digest('hex');await db.query('INSERT INTO veo_login_limits VALUES($1,now(),11)',[key]);
 const result=await rpc('veo_account_access',[owner]);const state=(who:string)=>result.accounts.find((a:any)=>a.id===who);
 expect(state(leader).status).toBe('email_required');expect(state(manager).status).toBe('password_required');expect(state(member).status).toBe('temporarily_locked');expect(state(owner).status).toBe('ready');expect(JSON.stringify(result)).not.toContain('veo-sha256:');
 await expect(rpc('veo_account_access',[leader])).rejects.toThrow('Owner access');
 for(const signature of ['veo_account_access(uuid)','veo_set_account_password(uuid,uuid,text)','veo_recover_account_login(uuid,uuid,text,text)'])expect((await db.query<any>("SELECT has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') exposed",[signature])).rows[0].exposed).toBe(false);
});
it('recovers the same staff identity, adds only its missing team and clears the email cooldown',async()=>{
 const recovered=id(9);await action(owner,'create_account',{user_id:recovered,parent_id:owner,role:'team_leader',name:'Recovered leader',email:'before@example.com',password_hash:stored,page_ids:[page,pageB]});
 await db.query('DELETE FROM veo_teams WHERE manager_id=$1',[recovered]);await db.query('UPDATE users SET email=NULL,password_hash=NULL,is_active=false WHERE id=$1',[recovered]);
 const before=(await db.query('SELECT * FROM user_pages ORDER BY user_id,page_id')).rows,roles=(await db.query('SELECT user_id,role,parent_id FROM veo_accounts ORDER BY user_id')).rows;
 const email='recovered@example.com',key=createHash('sha256').update(email).digest('hex');await db.query('INSERT INTO veo_login_limits VALUES($1,now(),11)',[key]);
 const saved=await rpc('veo_recover_account_login',[owner,recovered,' Recovered@Example.com ',stored]);expect(saved).toMatchObject({id:recovered,email,role:'team_leader',active:true});
 expect((await db.query('SELECT * FROM veo_login_limits WHERE key=$1',[key])).rows).toHaveLength(0);expect((await db.query('SELECT * FROM veo_teams WHERE manager_id=$1',[recovered])).rows).toHaveLength(1);
 expect((await db.query('SELECT * FROM user_pages ORDER BY user_id,page_id')).rows).toEqual(before);expect((await db.query('SELECT user_id,role,parent_id FROM veo_accounts ORDER BY user_id')).rows).toEqual(roles);
 const audit=(await db.query<any>("SELECT after_value FROM veo_audit WHERE action='account_login_recovery'")).rows;expect(JSON.stringify(audit)).not.toContain('veo-sha256:');
 await expect(rpc('veo_recover_account_login',[manager,recovered,email,stored])).rejects.toThrow('Owner account access');
 await expect(rpc('veo_recover_account_login',[owner,recovered,'owner@example.com',stored])).rejects.toThrow('another account');
});
it('never reactivates departed staff and rolls back misleading password-only changes on unconfigured accounts',async()=>{
 await db.query('UPDATE users SET email=NULL,password_hash=NULL,is_active=false WHERE id=$1',[member]);
 await expect(rpc('veo_set_account_password',[owner,member,stored])).rejects.toThrow('setup is incomplete');expect((await db.query<any>('SELECT password_hash FROM users WHERE id=$1',[member])).rows[0].password_hash).toBeNull();
 await db.query('UPDATE veo_accounts SET active=false,departed_at=now() WHERE user_id=$1',[member]);await expect(rpc('veo_recover_account_login',[owner,member,'former@example.com',stored])).rejects.toThrow('Owner account access');
 expect((await db.query<any>('SELECT is_active FROM users WHERE id=$1',[member])).rows[0].is_active).toBe(false);
});
it('keeps password changes scoped and clears cooldown only after a successful change',async()=>{
 const email=member+'@example.com',key=createHash('sha256').update(email).digest('hex');await db.query('INSERT INTO veo_login_limits VALUES($1,now(),11)',[key]);
 await expect(rpc('veo_set_account_password',[other,member,stored])).rejects.toThrow('Forbidden');expect((await db.query('SELECT * FROM veo_login_limits WHERE key=$1',[key])).rows).toHaveLength(1);
 expect(await rpc('veo_set_account_password',[manager,member,stored])).toMatchObject({user_id:member,password_changed:true});expect((await db.query('SELECT * FROM veo_login_limits WHERE key=$1',[key])).rows).toHaveLength(0);
});
it('lets a Team Leader handle a member directly without a manager while keeping existing email/password identities unchanged',async()=>{
 const before=(await db.query('SELECT id,email,password_hash FROM users ORDER BY id')).rows,direct=id(10),email='direct@example.com';
 await action(leader,'create_account',{user_id:direct,parent_id:leader,role:'member',name:'Direct member',email,password_hash:stored,page_ids:[page,pageB]});
 expect((await db.query<any>('SELECT parent_id,role FROM veo_accounts WHERE user_id=$1',[direct])).rows[0]).toEqual({parent_id:leader,role:'member'});
 await rpc('veo_sync_telegram_groups',[owner,JSON.stringify([{chat_id:-123,name:'Direct leader group',pages:[{id:page,matched:true},{id:pageB,matched:true}],topics:{},identities:[]}])]);
 const team=(await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1',[leader])).rows[0].id;
 await rpc('veo_telegram_group_action',[leader,'group',JSON.stringify({team_id:team,chat_id:-123,page_ids:[page,pageB]})]);
 await rpc('veo_telegram_group_action',[leader,'membership',JSON.stringify({user_id:direct,chat_id:-123,telegram_user_id:66})]);
 for(const p of [page,pageB])expect(await rpc('veo_telegram_destination',[team,p,direct])).toMatchObject({chat_id:-123});
 expect((await db.query('SELECT id,email,password_hash FROM users WHERE id<>$1 ORDER BY id',[direct])).rows).toEqual(before);
 const login=(await db.query<any>('SELECT email,password_hash FROM users WHERE id=$1',[direct])).rows[0];expect(login.email).toBe(email);expect(compareSync(createHash('sha256').update('test password').digest('base64'),login.password_hash.slice(11))).toBe(true);
});
it.each([leader,manager])('keeps multiple groups and multiple Pages for supervisor %s without duplicating destinations',async supervisor=>{
 const groups=[{chat_id:-123,name:'First',pages:[{id:page,matched:true}],topics:{},identities:[]},{chat_id:-456,name:'Second',pages:[{id:pageB,matched:true}],topics:{},identities:[]}];await rpc('veo_sync_telegram_groups',[owner,JSON.stringify(groups)]);
 const team=(await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1',[supervisor])).rows[0].id;
 const group=(chat:number,pages:string[],move=false)=>rpc('veo_telegram_group_action',[supervisor,'group',JSON.stringify({team_id:team,chat_id:chat,page_ids:pages,move_pages:move})]);
 await group(-123,[page]);await group(-456,[pageB]);let info=await rpc('veo_telegram_groups_page',[supervisor]);expect(info.links.filter((l:any)=>l.team_id===team)).toHaveLength(2);expect(info.routes.filter((r:any)=>r.team_id===team)).toHaveLength(2);
 const uid=supervisor===leader?44:55;for(const chat of [-123,-456])await rpc('veo_telegram_group_action',[supervisor,'membership',JSON.stringify({user_id:supervisor,chat_id:chat,telegram_user_id:uid})]);
 info=await rpc('veo_telegram_groups_page',[supervisor]);expect(info.memberships.filter((m:any)=>m.user_id===supervisor)).toHaveLength(2);
 await expect(group(-456,[page,pageB])).rejects.toThrow('Move Pages');await group(-456,[page,pageB],true);
 expect((await rpc('veo_telegram_groups_page',[supervisor])).routes.filter((r:any)=>r.team_id===team)).toHaveLength(2);
 await expect(rpc('veo_telegram_group_action',[member,'group',JSON.stringify({team_id:team,chat_id:-123,page_ids:[page]})])).rejects.toThrow('Supervisor access');
 expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(0);expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);
});
