import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = id(1), page = id(2), foreignPage = id(3), contact = id(4), leader = id(5), manager = id(6), member = id(7), otherManager = id(8), other = id(9);
let request = 100;
const action = async (db: PGlite, who: string, kind: string, data: any) => (await db.query<any>('SELECT veo_action($1,$2,$3) AS r', [who, kind, JSON.stringify(data)])).rows[0].r;
async function setup() {
    const db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE users(id uuid PRIMARY KEY,email text UNIQUE,name text,password_hash text,role text,is_active boolean DEFAULT true,facebook_id text);
      CREATE TABLE pages(id uuid PRIMARY KEY,fb_page_id text,name text);
      CREATE TABLE contacts(id uuid PRIMARY KEY,page_id uuid,name text,pipeline_stage text,psid text,profile_pic text,last_interaction_at timestamptz);
      CREATE TABLE user_pages(user_id uuid,page_id uuid,UNIQUE(user_id,page_id));
      CREATE TABLE campaigns(id uuid PRIMARY KEY,page_id uuid,created_at timestamptz,created_by uuid,status text);
      CREATE TABLE tags(id uuid PRIMARY KEY,page_id uuid);
      CREATE TABLE conversation_export_jobs(id uuid PRIMARY KEY,page_id uuid,created_at timestamptz);
      CREATE TABLE chatbot_media_assets(id uuid PRIMARY KEY,page_id uuid);
      CREATE TABLE workflow_automations(id uuid PRIMARY KEY,page_id uuid);
      INSERT INTO users VALUES('${owner}','cj@example.org','CJ',NULL,'user',true,NULL);
      INSERT INTO pages VALUES('${page}','veo-page','VEO'),('${foreignPage}','suno-page','Suno');
      INSERT INTO contacts(id,page_id,name,pipeline_stage) VALUES('${contact}','${page}','Client','converted');
      INSERT INTO user_pages VALUES('${owner}','${page}'),('${owner}','${foreignPage}');`);
    for (const file of ['202611050010_veo_workspace.sql', '202611050011_veo_workspace_workers.sql', '202611050012_veo_workspace_hardening.sql', '202611050013_veo_refund_and_submission_recovery.sql', '202611050014_veo_salary_reconciliation_queue.sql', '202611050015_veo_review_corrections.sql', '202611050016_veo_contacts_and_telegram_profile.sql', '202611050017_veo_team_capacity.sql', '202611050018_veo_current_team_planning.sql', '202611050019_veo_conversation_event_leases.sql', '202611050020_veo_staff_and_delivery.sql', '202611050021_veo_performance_finance.sql', '202611050022_veo_page_capacity_budget.sql', '202611050023_veo_telegram_workforce.sql', '202611050024_veo_shift_reports.sql', '202611050025_veo_current_telegram_group.sql']) await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    await db.query('SELECT veo_launch($1,$2)', [owner, [page]]);
    await db.exec("UPDATE veo_tenants SET launch_at=now()-interval '30 days'");
    const create = (actor: string, user: string, parent: string, role: string) => action(db, actor, 'create_account', { user_id: user, parent_id: parent, role, name: role, email: `${user}@example.org`, password_hash: 'x'.repeat(40), page_ids: [page] });
    await create(owner, leader, owner, 'team_leader');
    await create(leader, manager, leader, 'manager');
    await create(manager, member, manager, 'member');
    await create(owner, otherManager, owner, 'manager');
    await create(otherManager, other, otherManager, 'member');
    return db;
}
const order = (db: PGlite, seller = member, total = 10000) => action(db, seller, 'order', { request_id: id(request++), page_id: page, contact_id: contact, seller_id: seller, description: 'Video', total_minor: total, currency: 'PHP' });
async function payment(db: PGlite, orderId: string, amount: number, days = 0, kind = 'full', actor = member, extra: any = {}) {
    const at = (await db.query<any>(`SELECT (now()-($1::integer*interval '1 day')-interval '1 minute')::text AS t`, [days])).rows[0].t;
    return action(db, actor, 'payment', { order_id: orderId, request_id: id(request++), amount_minor: amount, reference: `REF-${request}`, occurred_at: at, kind, confirmed: true, reason: 'Bank correction', ...extra });
}

describe('VEO authoritative workspace', () => {
    it('operational budgets conserve worker quota across Pages and recover allocation when a preferred Page is revoked', async () => {
        const db=await setup();
        try {
            const pageB=id(92), tenant=(await db.query<any>('SELECT tenant_id FROM veo_accounts WHERE user_id=$1',[owner])).rows[0].tenant_id;
            await db.query('INSERT INTO pages(id,fb_page_id,name,veo_tenant_id,veo_enabled) VALUES($1,$2,$3,$4,true)',[pageB,'veo-page-b','Page B',tenant]);
            for(const user of [owner,leader,manager,member]) await db.query('INSERT INTO user_pages VALUES($1,$2)',[user,pageB]);
            await db.query("INSERT INTO veo_attendance(user_id,work_date,active,updated_by) SELECT user_id,veo_today(),true,$1 FROM veo_accounts WHERE role IN('member','manager')",[owner]);
            await db.query("SELECT veo_budget_action($1,'page_weight',$2)",[owner,JSON.stringify({user_id:member,page_id:page,weight:0})]);
            let plans=(await db.query<any>('SELECT veo_page_capacity($1,veo_today()) AS p',[owner])).rows[0].p.plans;
            const capacity=(await db.query<any>('SELECT veo_team_capacity($1) AS p',[owner])).rows[0].p;
            expect(plans.reduce((n:number,p:any)=>n+p.quota,0)).toBe(capacity.combined.quota.closed);
            expect(plans.find((p:any)=>p.page_id===pageB).workers.find((w:any)=>w.user_id===member).page_target).toBe(1);
            await expect(db.query('SELECT veo_page_capacity($1,veo_today())',[manager])).rejects.toThrow(/Owner or Team Leader/);
            await action(db,manager,'assign_pages',{user_id:member,page_ids:[page]});
            plans=(await db.query<any>('SELECT veo_page_capacity($1,veo_today()) AS p',[owner])).rows[0].p.plans;
            expect(plans.flatMap((p:any)=>p.workers).filter((w:any)=>w.user_id===member).reduce((n:number,w:any)=>n+w.page_target,0)).toBe(1);
            await expect(db.query("SELECT veo_budget_action($1,'page_weight',$2)",[owner,JSON.stringify({user_id:member,page_id:page,weight:0})])).rejects.toThrow(/positive weight/);
        } finally {await db.close();}
    },60000);
    it('operational finance allocates actual whole-day commission exactly and the compact calendar uses actual salary', async () => {
        const db=await setup();
        try {
            const pageB=id(93),contactB=id(94),tenant=(await db.query<any>('SELECT tenant_id FROM veo_accounts WHERE user_id=$1',[owner])).rows[0].tenant_id;
            await db.query('INSERT INTO pages(id,fb_page_id,name,veo_tenant_id,veo_enabled) VALUES($1,$2,$3,$4,true)',[pageB,'second-page','Second Page',tenant]);
            for(const user of [owner,leader,manager,member]) await db.query('INSERT INTO user_pages VALUES($1,$2)',[user,pageB]);
            await db.query("INSERT INTO contacts(id,page_id,name,pipeline_stage) VALUES($1,$2,'Second client','converted')",[contactB,pageB]);
            const a=await order(db,member,101);await payment(db,a.id,101);
            const b=await action(db,member,'order',{request_id:id(request++),page_id:pageB,contact_id:contactB,seller_id:member,description:'Second',total_minor:102,currency:'PHP'});await payment(db,b.id,102);
            const day=(await db.query<any>('SELECT veo_today()::text AS d')).rows[0].d;
            const salary=(await db.query<any>('SELECT veo_salary($1,$2) AS s',[member,day])).rows[0].s;
            const first=(await db.query<any>('SELECT veo_finance_days($1,$2,$2,$3,$4) AS f',[owner,day,page,member])).rows[0].f.days[0];
            const second=(await db.query<any>('SELECT veo_finance_days($1,$2,$2,$3,$4) AS f',[owner,day,pageB,member])).rows[0].f.days[0];
            expect(first.rate).toBe(40);expect(first.totals[0].commission_minor+second.totals[0].commission_minor).toBe(salary.totals[0].commission_minor);
            expect(salary.totals[0].commission_minor).toBe(81);
            await db.exec('CREATE TABLE ad_daily_spend(page_id uuid,spend_date date,currency text,amount numeric,pht_aligned boolean,report_complete boolean)');
            await db.query("INSERT INTO ad_daily_spend VALUES($1,veo_today(),'PHP',1,true,true)",[page]);
            const calendar=(await db.query<any>('SELECT veo_calendar_finance($1,$2,$2) AS c',[owner,day])).rows[0].c;
            expect(calendar.days[0].totals[0]).toMatchObject({gross_minor:203,commission_minor:81});
            expect(calendar.days[0].spend[0]).toMatchObject({amount_minor:100,complete:true});
        }finally{await db.close();}
    },60000);
    it('operational Telegram observations import tomorrow votes and require verified membership history before automatic removal',async()=>{
        const db=await setup();
        try {
            const tenant=(await db.query<any>('SELECT tenant_id FROM veo_accounts WHERE user_id=$1',[member])).rows[0].tenant_id;
            const team=(await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1',[manager])).rows[0].id;
            await action(db,owner,'mapping',{team_id:team,chat_id:-100123});
            await db.query('SELECT veo_map_staff_telegram($1,$2,321,-100123)',[owner,member]);
            await db.query('SELECT veo_map_staff_telegram($1,$2,322,-100123)',[owner,leader]);
            const tomorrow=(await db.query<any>('SELECT (veo_today()+1)::text AS d')).rows[0].d;
            const time=(ms:number)=>new Date(Date.now()+ms).toISOString();
            const person=(ms:number,more:any={})=>({user_id:member,telegram_user_id:321,chat_id:-100123,observed_at:time(ms),membership:'member',is_bot:false,membership_confirmed:true,...more});
            const apply=async(p:any)=>(await db.query<any>('SELECT veo_apply_telegram_observations($1,$2) AS r',[tenant,JSON.stringify({tenant_id:tenant,workers:[p]})])).rows[0].r;
            await apply(person(0,{attendance:{work_date:tomorrow,active:true,updated_at:time(-1000)}}));
            expect((await db.query<any>('SELECT active,source FROM veo_attendance WHERE user_id=$1 AND work_date=$2',[member,tomorrow])).rows[0]).toEqual({active:true,source:'telegram'});
            await action(db,member,'attendance',{user_id:member,work_date:tomorrow,active:false});
            await apply(person(1000,{attendance:{work_date:tomorrow,active:true,updated_at:time(-1000)}}));
            expect((await db.query<any>('SELECT active,source FROM veo_attendance WHERE user_id=$1 AND work_date=$2',[member,tomorrow])).rows[0]).toEqual({active:false,source:'workspace'});
            await apply(person(2000,{membership:'unknown',membership_confirmed:false,is_bot:null,error:'lookup_failed'}));
            expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1',[member])).rows[0].active).toBe(true);
            await action(db,owner,'mapping',{team_id:team,chat_id:-100456});
            expect((await db.query<any>('SELECT veo_current_telegram_group($1) AS chat',[leader])).rows[0].chat).toBeNull();
            await apply(person(3000,{user_id:leader,telegram_user_id:322,membership:'left'}));
            expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1',[leader])).rows[0].active).toBe(true);
            await apply(person(3000,{chat_id:-100456,membership:'left'}));
            expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1',[member])).rows[0].active).toBe(true);
            await apply(person(4000,{chat_id:-100456}));
            await apply(person(5000,{chat_id:-100456,membership:'left'}));
            expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1',[member])).rows[0].active).toBe(false);
            await action(db,owner,'mapping',{team_id:team,chat_id:-100123});
            await apply(person(6000,{user_id:leader,telegram_user_id:322,membership:'left'}));
            expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1',[leader])).rows[0].active).toBe(false);
            expect((await db.query<any>('SELECT veo_can_page($1,$2) AS allowed',[manager,page])).rows[0].allowed).toBe(true);
            expect((await db.query<any>('SELECT veo_scope($1) AS s',[owner])).rows[0].s.role).toBe('owner');
        }finally{await db.close();}
    },60000);
    it('operational reports expose full eligible client lists, common Page targets and stable permission fingerprints',async()=>{
        const db=await setup();
        try{
            const o=await order(db);await payment(db,o.id,2000,1,'deposit');
            await action(db,member,'fulfillment',{order_id:o.id,status:'ready_waiting_payment',reason:'Client has not completed payment',work_complete:true});
            const row=(await db.query<any>('SELECT tenant_id,veo_today()::text AS d FROM veo_accounts WHERE user_id=$1',[owner])).rows[0];
            const report=(await db.query<any>('SELECT veo_operations_report($1,$2) AS r',[row.tenant_id,row.d])).rows[0].r;
            const team=report.teams.find((t:any)=>t.workers.some((w:any)=>w.id===member));
            expect(report.report_version).toBe(2);expect(team.access_signature).toMatch(/^[a-f0-9]{32}$/);
            const client=team.workers.find((w:any)=>w.id===member).clients[0];
            expect(client).toMatchObject({waiting_payment:true,overdue:false,work_status:'ready_waiting_payment'});
            const snapshot=team.access_signature;
            await action(db,owner,'assign_pages',{user_id:leader,page_ids:[]});
            const changed=(await db.query<any>('SELECT veo_operations_report($1,$2) AS r',[row.tenant_id,row.d])).rows[0].r.teams.find((t:any)=>t.id===team.id);
            expect(changed.access_signature).not.toBe(snapshot);
        }finally{await db.close();}
    },60000);
    it('staff operations revoke fired staff, release unfinished clients and preserve completed salary attribution', async () => {
        const db = await setup();
        try {
            const pending = await order(db); await payment(db,pending.id,3000,2,'deposit');
            const paid = await order(db); await payment(db,paid.id,10000);
            const olderPaid = await order(db); await payment(db,olderPaid.id,10000,2);
            await expect(action(db,otherManager,'staff_delete',{user_id:member,reason:'Dismissed'})).rejects.toThrow(/branch/);
            await expect(action(db,member,'staff_delete',{user_id:other,reason:'Dismissed'})).rejects.toThrow(/branch/);
            await action(db,manager,'staff_delete',{user_id:member,reason:'Employment ended'});
            expect((await db.query<any>('SELECT veo_scope($1) AS s,veo_can_page($1,$2) AS allowed',[member,page])).rows[0]).toEqual({s:null,allowed:false});
            const day = (await db.query<any>('SELECT veo_today()::text AS d')).rows[0].d;
            const report = (await db.query<any>('SELECT veo_operations($1,$2,$2) AS r',[owner,day])).rows[0].r;
            expect(report.employees.find((e:any)=>e.id===member)).toMatchObject({active:false,done:1});
            expect(report.finance.days.find((d:any)=>d.user_id===member).totals[0].gross_minor).toBe(10000);
            expect(report.summary.released_clients).toBe(1);
            await action(db,other,'claim_client',{contact_id:contact});
            const orders = (await db.query<any>('SELECT id,seller_id FROM veo_orders ORDER BY id')).rows;
            expect(orders.find(o=>o.id===pending.id).seller_id).toBe(other);
            expect(orders.find(o=>o.id===paid.id).seller_id).toBe(member);
            expect(orders.find(o=>o.id===olderPaid.id).seller_id).toBe(member);
            const takeover = (await db.query<any>('SELECT veo_operations($1,$2,$2) AS r',[owner,day])).rows[0].r;
            expect(takeover.employees.find((e:any)=>e.id===other)).toMatchObject({done:0,overdue:2});
            expect(takeover.employees.find((e:any)=>e.id===member)).toMatchObject({done:1,overdue:0});
            expect(takeover.page_rankings.find((e:any)=>e.user_id===other)).toMatchObject({done:0,overdue:2});
            await expect(action(db,manager,'claim_client',{contact_id:contact})).rejects.toThrow(/no longer available/);
            await payment(db,pending.id,7000,0,'balance',other);
            expect((await db.query<any>('SELECT veo_salary($1,veo_today()) AS s',[other])).rows[0].s.done).toBe(1);
            await action(db,owner,'staff_delete',{user_id:other,reason:'Replacement worker also left'});
            await action(db,manager,'claim_client',{contact_id:contact});
            expect((await db.query<any>('SELECT count(*)::int AS n FROM veo_order_work WHERE assignee_id=$1',[manager])).rows[0].n).toBe(3);
            expect((await db.query<any>('SELECT seller_id FROM veo_orders WHERE id=$1',[olderPaid.id])).rows[0].seller_id).toBe(member);
        } finally { await db.close(); }
    },60000);
    it('staff operations preserve active descendants when a supervisor leaves and isolate performance by branch', async () => {
        const db = await setup();
        try {
            await action(db,owner,'staff_delete',{user_id:manager,reason:'Manager left the team'});
            expect((await db.query<any>('SELECT veo_can_page($1,$2) AS allowed',[member,page])).rows[0].allowed).toBe(true);
            expect((await db.query<any>('SELECT veo_can_page($1,$2) AS allowed',[manager,page])).rows[0].allowed).toBe(false);
            const one=await order(db); await payment(db,one.id,10000);
            const two=await order(db,other); await payment(db,two.id,10000,0,'full',other);
            const day=(await db.query<any>('SELECT veo_today()::text AS d')).rows[0].d;
            const leaderView=(await db.query<any>('SELECT veo_operations($1,$2,$2) AS r',[leader,day])).rows[0].r;
            expect(leaderView.summary.done).toBe(1);
            expect(JSON.stringify(leaderView)).not.toContain(otherManager);
            expect(leaderView.page_rankings.find((r:any)=>r.user_id===member).rank).toBe(1);
            await expect(db.query('SELECT veo_calendar_finance($1,$2,$2)',[member,day])).rejects.toThrow(/restricted/);
            await expect(db.query('SELECT veo_calendar_finance($1,$2,$2)',[otherManager,day])).rejects.toThrow(/restricted/);
            expect((await db.query<any>('SELECT veo_calendar_finance($1,$2,$2) AS c',[leader,day])).rows[0].c.days[0].totals[0].commission_minor).toBe(4000);
        } finally { await db.close(); }
    },60000);
    it('staff operations separate overdue work from completed work awaiting a client balance, and verify both payment entry flows', async () => {
        const db=await setup();
        try {
            const o=await order(db); await payment(db,o.id,2000,2,'deposit');
            const day=(await db.query<any>('SELECT veo_today()::text AS d')).rows[0].d;
            const report=async()=> (await db.query<any>('SELECT veo_operations($1,$2,$2) AS r',[manager,day])).rows[0].r;
            expect((await report()).summary).toMatchObject({waiting_payment:1,overdue:1});
            await expect(action(db,member,'fulfillment',{order_id:o.id,status:'ready_waiting_payment',reason:'Client balance pending',work_complete:false})).rejects.toThrow(/Confirm/);
            await action(db,member,'fulfillment',{order_id:o.id,status:'ready_waiting_payment',reason:'Project is ready; client has not paid the balance',work_complete:true});
            expect((await report()).summary).toMatchObject({waiting_payment:1,overdue:0});
            await db.exec("UPDATE contacts SET pipeline_stage='order_created'");
            await payment(db,o.id,8000,0,'balance',member,{confirm_converted:true});
            const fact=(await db.query<any>('SELECT * FROM veo_order_facts WHERE id=$1',[o.id])).rows[0]; expect(fact.converted).toBe(true); expect(Number(fact.paid_minor)).toBe(10000);
            expect((await report()).summary).toMatchObject({done:1,waiting_payment:0,overdue:0});
            const another=await order(db); await expect(payment(db,another.id,10000,0,'full',member,{confirmed:false,confirm_converted:true})).rejects.toThrow(/Verify/);
        } finally {await db.close();}
    },60000);
    it('leases different conversations together while fencing later inbound, echo and standby events for a busy or retrying client', async () => {
        const db = await setup();
        try {
            const event = (person: string, outbound = false, standby = false) => ({ object: 'page', entry: [{ id: 'veo-page', [standby ? 'standby' : 'messaging']: [{ sender: { id: outbound ? 'veo-page' : person }, recipient: { id: outbound ? person : 'veo-page' }, message: { mid: Math.random().toString() } }] }] });
            for (const [key, payload] of [['e1', event('client-a')], ['e2', event('client-a', true)], ['e3', event('client-b')], ['e4', event('client-a', false, true)]] as const)
                await db.query('SELECT veo_ingest_event($1,$2,now(),$3)', ['veo-page', key, JSON.stringify(payload)]);
            const rows = (await db.query<any>('SELECT * FROM veo_claim_events(20)')).rows;
            expect(rows.map(r => r.event_key).sort()).toEqual(['e1','e3']);
            const lane = rows.find(r => r.event_key === 'e1').conversation_key;
            expect((await db.query<any>("SELECT conversation_key FROM veo_event_inbox WHERE event_key IN('e1','e2','e4')")).rows.every(r => r.conversation_key === lane)).toBe(true);
            expect((await db.query('SELECT * FROM veo_claim_events(20)')).rows).toHaveLength(0);
            await db.exec("UPDATE veo_event_inbox SET status='queued',next_attempt_at=now()+interval '1 hour' WHERE event_key='e1'");
            expect((await db.query('SELECT * FROM veo_claim_events(20)')).rows).toHaveLength(0);
            await db.exec("UPDATE veo_event_inbox SET status='done' WHERE event_key='e1'");
            expect((await db.query<any>('SELECT * FROM veo_claim_events(20)')).rows.map(r => r.event_key)).toEqual(['e2']);
            await db.exec("UPDATE veo_event_inbox SET lease_until=now()-interval '1 second' WHERE event_key='e2'");
            expect((await db.query<any>('SELECT * FROM veo_claim_events(20)')).rows[0]).toMatchObject({ event_key: 'e2', attempts: 2 });
            expect((await db.query("SELECT * FROM veo_claim_events(0)")).rows).toHaveLength(0);
            expect((await db.query<any>("SELECT has_function_privilege('anon','veo_claim_events(integer)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
        } finally { await db.close(); }
    }, 60000);
    it('keeps 35% until BOTH personal quotas are met, then applies 40% to the whole fully paid day', async () => {
        const db = await setup();
        try {
            await db.query('INSERT INTO veo_daily_targets(user_id,work_date,target,basis) VALUES($1,veo_today(),2,\'{}\') ON CONFLICT(user_id,work_date) DO UPDATE SET target=2', [member]);
            const carried = await order(db); await payment(db, carried.id, 2000, 1, 'deposit'); await payment(db, carried.id, 8000, 0, 'balance');
            const first = await order(db); await payment(db, first.id, 2000, 0, 'deposit');
            const second = await order(db); await payment(db, second.id, 2000, 0, 'deposit');
            let salary = (await db.query<any>('SELECT veo_salary($1,veo_today()) AS r', [member])).rows[0].r;
            expect(salary).toMatchObject({ target: 2, closed: 2, done: 1, rate: 35 });
            expect(salary.totals[0].commission_minor).toBe(3500);
            await payment(db, first.id, 8000, 0, 'balance');
            salary = (await db.query<any>('SELECT veo_salary($1,veo_today()) AS r', [member])).rows[0].r;
            expect(salary).toMatchObject({ target: 2, closed: 2, done: 2, rate: 40 });
            expect(salary.totals[0].gross_minor).toBe(20000);
            expect(salary.totals[0].commission_minor).toBe(8000);
        } finally { await db.close(); }
    }, 60000);
    it('adds worker targets into team quotas and weighted branch averages without exposing other workers finance or changing commission', async () => {
        const db = await setup();
        try {
            await db.query('UPDATE veo_daily_targets SET target=3 WHERE user_id=$1 AND work_date=veo_today()', [manager]);
            await db.query('UPDATE veo_daily_targets SET target=8 WHERE user_id=$1 AND work_date=veo_today()', [otherManager]);
            await db.query('UPDATE veo_accounts SET active=false WHERE user_id=$1', [other]);
            await db.query('INSERT INTO veo_attendance SELECT user_id,veo_today(),true,$1,now() FROM veo_accounts WHERE role IN($2,$3)', [owner,'manager','member']);
            const carried = await order(db); await payment(db, carried.id, 2000, 1, 'deposit'); await payment(db, carried.id, 8000, 0, 'balance');
            for (let i=0;i<4;i++) { const o = await order(db, manager); await payment(db, o.id, 10000, 0, 'full', manager); }
            const team = (await db.query<any>('SELECT veo_team_capacity($1) AS r', [member])).rows[0].r;
            expect(team.teams).toHaveLength(1); expect(team.teams[0].manager_id).toBe(manager);
            expect(team.combined).toMatchObject({ workers: 2, capacity: 4, average_worker_capacity: 2, closed: 4, done: 5, quota: { closed: 4, done: 4, met: true } });
            expect(JSON.stringify(team)).not.toContain('commission_minor'); expect(JSON.stringify(team)).not.toContain(otherManager);
            const salary = (await db.query<any>('SELECT veo_salary($1,veo_today()) AS r', [member])).rows[0].r;
            expect(salary).toMatchObject({ closed: 0, done: 1, rate: 35 });
            const ownerMetrics = (await db.query<any>('SELECT veo_team_capacity($1) AS r', [owner])).rows[0].r;
            expect(ownerMetrics.combined).toMatchObject({ workers: 3, capacity: 12, average_worker_capacity: 4 });
            await db.query('UPDATE veo_attendance SET active=false WHERE user_id=$1 AND work_date=veo_today()', [member]);
            expect((await db.query<any>('SELECT veo_team_capacity($1) AS r',[member])).rows[0].r.combined.quota.closed).toBe(3);
            // A newly enrolled worker updates current planning without altering the
            // immutable individual targets or a previously completed team snapshot.
            const added = id(82);
            await action(db,manager,'create_account',{user_id:added,parent_id:manager,role:'member',name:'New worker',email:'new-worker@example.org',password_hash:'x'.repeat(40),page_ids:[page]});
            expect((await db.query<any>('SELECT veo_team_capacity($1) AS r',[member])).rows[0].r.combined).toMatchObject({ workers:3,capacity:5 });
            const teamId=team.teams[0].id;
            await db.query('INSERT INTO veo_team_daily_capacity(team_id,work_date,workers,capacity,participating,inactive,unknown,quota) VALUES($1,veo_today()-1,2,4,1,1,0,3)',[teamId]);
            expect((await db.query<any>('SELECT veo_team_capacity($1,veo_today()-1) AS r',[member])).rows[0].r.combined).toMatchObject({workers:2,capacity:4,quota:{closed:3}});
            await expect(db.exec('UPDATE veo_team_daily_capacity SET capacity=99 WHERE work_date<veo_today()')).rejects.toThrow(/read-only/);
            expect((await db.query<any>('SELECT veo_team_capacity($1) AS r', [leader])).rows[0].r.teams).toHaveLength(1);
            expect((await db.query<any>("SELECT has_function_privilege('anon','veo_team_capacity(uuid,date)','EXECUTE') AS ok")).rows[0].ok).toBe(false);
        } finally { await db.close(); }
    }, 60000);
    it('averages combined team output across completed PHT dates, including zero days and excluding today and older history', async () => {
        const db = await setup();
        try {
            for (const [days, quantity] of [[2,5],[3,1],[4,3],[15,9],[0,2]]) for (let i=0;i<quantity;i++) { const o=await order(db); await payment(db,o.id,10000,days); }
            const metrics = (await db.query<any>('SELECT veo_team_capacity($1) AS r',[member])).rows[0].r.combined;
            expect(metrics.history).toMatchObject({ completed_days: 14, done_total: 9, average_done_per_day: 0.64, best_three_average: 3, eligible_days: 3 });
            expect(metrics.history.days.filter((d: any) => d.done===0)).toHaveLength(11);
            const future = (await db.query<any>('SELECT (veo_today()+1)::text AS day')).rows[0].day;
            await expect(db.query('SELECT veo_team_capacity($1,$2)',[member,future])).rejects.toThrow(/Date outside/);
            await expect(db.query('SELECT veo_team_capacity($1)',[id(999)])).rejects.toThrow(/Forbidden/);
        } finally { await db.close(); }
    }, 60000);
    it('updates active-tomorrow team quotas, preserves individual snapshots and shares the same aggregates with Jaucian', async () => {
        const db = await setup();
        try {
            const tomorrow = (await db.query<any>('SELECT (veo_today()+1)::text AS day')).rows[0].day;
            await action(db,member,'attendance',{work_date:tomorrow,active:true});
            let metrics = (await db.query<any>('SELECT veo_team_capacity($1) AS r',[manager])).rows[0].r;
            expect(metrics.combined.tomorrow).toMatchObject({ active:1, unknown:1, capacity:1, full_capacity:2, average_active_capacity:1 });
            await action(db,manager,'attendance',{work_date:tomorrow,active:true});
            metrics = (await db.query<any>('SELECT veo_team_capacity($1) AS r',[manager])).rows[0].r;
            expect(metrics.combined.tomorrow).toMatchObject({ active:2, unknown:0, capacity:2 });
            await action(db,member,'attendance',{work_date:tomorrow,active:false});
            metrics = (await db.query<any>('SELECT veo_team_capacity($1) AS r',[manager])).rows[0].r;
            expect(metrics.combined.tomorrow).toMatchObject({ active:1, inactive:1, capacity:1 });
            const tenant = (await db.query<any>('SELECT tenant_id FROM veo_accounts WHERE user_id=$1',[owner])).rows[0].tenant_id;
            const report = (await db.query<any>('SELECT veo_jaucian_report($1,veo_today()) AS r',[tenant])).rows[0].r;
            expect(report.teams.find((t: any)=>t.id===metrics.teams[0].id).capacity).toEqual(metrics.teams[0]);
            expect(metrics.combined.capacity).toBe(2);
        } finally { await db.close(); }
    }, 60000);
    it('searches visible contacts without orders by name, client ID and manual details, with pagination and revocation', async () => {
        const db = await setup();
        try {
            await db.exec(`UPDATE contacts SET name='Searchable Client',psid='client-unique-42' WHERE id='${contact}';
              INSERT INTO contacts(id,page_id,name) VALUES('${id(70)}','${foreignPage}','Hidden Client');
              INSERT INTO contacts(id,page_id,name) SELECT gen_random_uuid(),'${page}','Client '||n FROM generate_series(1,30) n;`);
            await action(db, member, 'contact', { contact_id: contact, fields: { phone: '0917-000-1234' } });
            const search = async (query = '', offset = 0) => (await db.query<any>('SELECT veo_contacts_page($1,NULL,$2,$3,25) AS r', [member, query, offset])).rows[0].r;
            expect((await search('SEARCHABLE')).items.map((c: any) => c.id)).toEqual([contact]);
            expect((await search('unique-42')).items[0].id).toBe(contact);
            expect((await search('0917-000')).items[0].id).toBe(contact);
            expect((await search('Hidden')).total).toBe(0);
            expect((await search('%')).total).toBe(0);
            const first = await search(), second = await search('', 25);
            expect(first.total).toBe(31); expect(first.items).toHaveLength(25); expect(second.items).toHaveLength(6);
            expect(new Set([...first.items, ...second.items].map(c => c.id)).size).toBe(31);
            await action(db, manager, 'assign_pages', { user_id: member, page_ids: [] });
            expect((await search('Searchable')).total).toBe(0);
            await expect(db.query('SELECT veo_contacts_page($1,$2)', [member, page])).rejects.toThrow(/Forbidden/);
        } finally { await db.close(); }
    }, 60000);
    it('saves only self-reported Telegram profile metadata with an audit record and leaves delivery mappings and roles unchanged', async () => {
        const db = await setup();
        try {
            const saved = (await db.query<any>('SELECT veo_save_telegram_profile($1,$2,false) AS r', [member, ' @My_Username '])).rows[0].r;
            expect(saved.telegram_username).toBe('my_username'); expect(saved.telegram_profile_completed_at).toBeTruthy();
            const scope = (await db.query<any>('SELECT veo_scope($1) AS r', [member])).rows[0].r;
            expect(scope.role).toBe('member'); expect(scope.telegram_username).toBe('my_username');
            expect((await db.query<any>('SELECT count(*)::int AS n FROM veo_worker_mappings')).rows[0].n).toBe(0);
            const dashboard = (await db.query<any>('SELECT veo_dashboard($1) AS r', [manager])).rows[0].r;
            expect(dashboard.accounts.find((a: any) => a.id === member).telegram_username).toBe('my_username');
            await expect(db.query('SELECT veo_save_telegram_profile($1,$2,false)', [member, 'https://telegram.me/wrong'])).rejects.toThrow();
            const removed = (await db.query<any>('SELECT veo_save_telegram_profile($1,$2,true) AS r', [member, ''])).rows[0].r;
            expect(removed.telegram_username).toBeNull(); expect(removed.telegram_profile_completed_at).toBeTruthy();
            expect((await db.query<any>("SELECT count(*)::int AS n FROM veo_audit WHERE action='telegram_profile'")).rows[0].n).toBe(2);
            expect((await db.query<any>("SELECT has_function_privilege('anon','veo_save_telegram_profile(uuid,text,boolean)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
        } finally { await db.close(); }
    }, 60000);
    it('preserves audited manual identity corrections against later syncs and requires the immediate supervisor page scope', async () => {
        const db = await setup();
        try {
            await action(db, member, 'contact', { contact_id: contact, name: 'Corrected client', fields: { phone: '09123' } });
            await db.query('UPDATE contacts SET name=$1 WHERE id=$2', ['Facebook supplied name', contact]);
            expect((await db.query<any>('SELECT name FROM contacts WHERE id=$1', [contact])).rows[0].name).toBe('Corrected client');
            await action(db, leader, 'contact', { contact_id: contact, fields: { email: 'client@example.org' } });
            await db.query('UPDATE contacts SET name=$1 WHERE id=$2', ['AI supplied name', contact]);
            expect((await db.query<any>('SELECT name FROM contacts WHERE id=$1', [contact])).rows[0].name).toBe('Corrected client');
            await action(db, owner, 'contact', { contact_id: contact, name: '', fields: {} });
            await db.query('UPDATE contacts SET name=$1 WHERE id=$2', ['Facebook name after explicit clearing', contact]);
            expect((await db.query<any>('SELECT name FROM contacts WHERE id=$1', [contact])).rows[0].name).toBeNull();
            expect((await db.query<any>("SELECT after_value->>'manual_name' AS name FROM veo_audit WHERE action='contact' ORDER BY id LIMIT 1")).rows[0].name).toBe('Corrected client');
            await action(db, owner, 'assign_pages', { user_id: leader, page_ids: [] });
            await expect(action(db, owner, 'assign_pages', { user_id: member, page_ids: [page] })).rejects.toThrow(/supervisor scope/);
            await expect(action(db, member, 'contact', { contact_id: contact, name: 'Unauthorized', fields: {} })).rejects.toThrow();
        } finally { await db.close(); }
    }, 60000);
    it('finds older deals beyond 500 orders with stable pagination and seller, page, date and search boundaries', async () => {
        const db = await setup();
        try {
            const oldest = await order(db);
            await payment(db, oldest.id, 10000, 2);
            const day = (await db.query<any>('SELECT done_date::text AS day FROM veo_order_facts WHERE id=$1', [oldest.id])).rows[0].day;
            await db.exec(`INSERT INTO veo_orders(request_id,tenant_id,team_id,page_id,contact_id,seller_id,description,total_minor,currency,created_by,created_at)
              SELECT gen_random_uuid(),tenant_id,team_id,page_id,contact_id,seller_id,'Newer order '||n,total_minor,currency,created_by,created_at+interval '1 minute'
              FROM veo_orders CROSS JOIN generate_series(1,505) n WHERE id='${oldest.id}'`);
            const list = async (who: string, view = 'dashboard', offset = 0, search = '') => (await db.query<any>('SELECT veo_orders_page($1,$2,$3,$4,$5,$6,50) AS r', [who, day, view, page, search, offset])).rows[0].r;
            const first = await list(member), next = await list(member, 'dashboard', 50);
            expect(first.total).toBe(506); expect(first.orders).toHaveLength(50);
            expect(new Set([...first.orders, ...next.orders].map(o => o.id)).size).toBe(100);
            expect((await list(member, 'done')).orders.map((o: any) => o.id)).toEqual([oldest.id]);
            expect((await list(member, 'dashboard', 500)).orders.map((o: any) => o.id)).toContain(oldest.id);
            expect((await list(member, 'dashboard', 0, 'Newer order 505')).total).toBe(1);
            expect((await list(other, 'done')).total).toBe(0);
            expect((await list(manager, 'clients')).total).toBe(0);
            await expect(db.query('SELECT veo_orders_page($1,$2,$3,$4)', [member, day, 'done', foreignPage])).rejects.toThrow(/Forbidden/);
        } finally { await db.close(); }
    }, 60000);
    it('restores commission when a refunded deposit or completion is subsequently repaid, without counting another Done Deal', async () => {
        const db = await setup();
        try {
            const o = await order(db);
            await payment(db, o.id, 3000, 3, 'deposit');
            await payment(db, o.id, 1000, 2, 'refund', manager);
            await payment(db, o.id, 8000, 1, 'balance');
            const day = (await db.query<any>('SELECT done_date::text AS day FROM veo_order_facts WHERE id=$1', [o.id])).rows[0].day;
            const salary = async () => (await db.query<any>('SELECT veo_salary($1,$2) AS r', [member, day])).rows[0].r;
            expect((await salary()).totals[0]).toMatchObject({ gross_minor: 10000, commission_minor: 3500 });
            await db.exec('SELECT veo_maintenance()');
            await payment(db, o.id, 2000, 0, 'refund', manager);
            await db.exec('SELECT veo_maintenance()');
            expect((await salary()).totals[0]).toMatchObject({ gross_minor: 8000, commission_minor: 2800 });
            await payment(db, o.id, 2000, 0, 'balance');
            await db.exec('SELECT veo_maintenance()');
            expect((await salary()).totals[0]).toMatchObject({ gross_minor: 10000, commission_minor: 3500 });
            expect((await salary()).done).toBe(1);
            const adjustments = (await db.query<any>('SELECT amount_minor FROM veo_salary_adjustments WHERE user_id=$1 AND work_date=$2 ORDER BY id', [member, day])).rows.map(r => Number(r.amount_minor));
            expect(adjustments).toEqual([-700, 700]);
        } finally { await db.close(); }
    }, 60000);
    it('requires both targets and applies the final rate to every completion that day', async () => {
        const db = await setup();
        try {
            const carried = await order(db);
            const dates = (await db.query<any>('SELECT (veo_today()-1)::text AS yesterday,veo_today()::text AS today')).rows[0];
            await payment(db, carried.id, 2000, 1, 'deposit', member, { occurred_at: `${dates.yesterday}T23:59:59+08:00` });
            await payment(db, carried.id, 8000, 0, 'balance', member, { occurred_at: `${dates.today}T00:00:00+08:00` });
            expect((await db.query<any>('SELECT closed_date::text,done_date::text FROM veo_order_facts WHERE id=$1', [carried.id])).rows[0]).toEqual({ closed_date: dates.yesterday, done_date: dates.today });
            let s = (await db.query<any>('SELECT veo_salary($1,veo_today()) AS r', [member])).rows[0].r;
            expect(s).toMatchObject({ closed: 0, done: 1, rate: 35 }); expect(s.totals[0].commission_minor).toBe(3500);
            const immediate = await order(db); await payment(db, immediate.id, 10000);
            s = (await db.query<any>('SELECT veo_salary($1,veo_today()) AS r', [member])).rows[0].r;
            expect(s).toMatchObject({ closed: 1, done: 2, rate: 40 }); expect(s.totals[0].commission_minor).toBe(8000);
            const tomorrow = (await db.query<any>('SELECT (veo_today()+1)::text AS d')).rows[0].d;
            await action(db, member, 'attendance', { active: true, work_date: tomorrow });
            await action(db, other, 'attendance', { active: true, work_date: tomorrow });
            const dashboard = (await db.query<any>('SELECT veo_dashboard($1) AS r', [owner])).rows[0].r;
            expect(dashboard.tomorrow.filter((w: any) => w.active).reduce((n: number, w: any) => n + w.target, 0)).toBe(2);
        } finally { await db.close(); }
    }, 60000);
    it('isolates another tenant and rechecks queued campaign authorization after revocation', async () => {
        const db = await setup();
        try {
            const stranger = id(90), tenant = id(91), campaign = id(92);
            await db.exec(`INSERT INTO users(id,email,name) VALUES('${stranger}','other@example.org','Other owner');
              INSERT INTO veo_tenants(id,owner_id,launch_at) VALUES('${tenant}','${stranger}',now());
              INSERT INTO veo_accounts VALUES('${stranger}','${tenant}','owner',NULL,true);
              UPDATE pages SET veo_tenant_id='${tenant}',veo_enabled=true WHERE id='${foreignPage}';
              INSERT INTO user_pages VALUES('${stranger}','${foreignPage}');
              INSERT INTO campaigns VALUES('${campaign}','${page}',now(),'${member}','scheduled');`);
            expect((await db.query<any>('SELECT veo_authorize_resources($1,$2) AS ok', [owner, JSON.stringify([{ kind: 'page', id: foreignPage }])])).rows[0].ok).toBe(false);
            expect((await db.query<any>("SELECT veo_send_allowed('veo-page',NULL,$1) AS ok", [campaign])).rows[0].ok).toBe(true);
            await action(db, manager, 'assign_pages', { user_id: member, page_ids: [] });
            expect((await db.query<any>("SELECT veo_send_allowed('veo-page',NULL,$1) AS ok", [campaign])).rows[0].ok).toBe(false);
            await expect(action(db, stranger, 'assign_pages', { user_id: member, page_ids: [page] })).rejects.toThrow();
        } finally { await db.close(); }
    }, 60000);
    it('enforces the creation hierarchy, branch boundaries, shared pages and revocation', async () => {
        const db = await setup();
        try {
            expect((await db.query<any>('SELECT veo_can_page($1,$2) AS ok', [member, page])).rows[0].ok).toBe(true);
            expect((await db.query<any>('SELECT veo_can_page($1,$2) AS ok', [member, foreignPage])).rows[0].ok).toBe(false);
            await expect(action(db, member, 'create_account', { user_id: id(40), parent_id: manager, role: 'manager', page_ids: [page] })).rejects.toThrow();
            await expect(action(db, manager, 'assign_pages', { user_id: other, page_ids: [page] })).rejects.toThrow();
            await expect(action(db, owner, 'assign_pages', { user_id: manager, page_ids: [foreignPage] })).rejects.toThrow();
            const o = await order(db, other);
            await expect(payment(db, o.id, 100, 0, 'deposit', member)).rejects.toThrow();
            await action(db, owner, 'assign_pages', { user_id: leader, page_ids: [] });
            expect((await db.query<any>('SELECT veo_can_page($1,$2) AS ok', [member, page])).rows[0].ok).toBe(false);
            expect((await db.query<any>('SELECT veo_can_page($1,$2) AS ok', [other, page])).rows[0].ok).toBe(true);
        } finally { await db.close(); }
    }, 60000);
    it('handles deposits, full payment, duplicate retries, refunds, attribution and PHT dates', async () => {
        const db = await setup();
        try {
            const o = await order(db);
            const dep = await payment(db, o.id, 3000, 2, 'deposit');
            await payment(db, o.id, 7000, 1, 'balance');
            const facts = (await db.query<any>('SELECT * FROM veo_order_facts WHERE id=$1', [o.id])).rows[0];
            expect(Number(facts.paid_minor)).toBe(10000); expect(facts.done_at).toBeTruthy(); expect(facts.closed_date).not.toEqual(facts.done_date);
            const duplicate = await action(db, member, 'payment', { ...dep, confirmed: true, order_id: o.id });
            expect(duplicate.id).toBe(dep.id);
            await expect(action(db, member, 'payment', { ...dep, confirmed: true, order_id: o.id, occurred_at: new Date().toISOString() })).rejects.toThrow(/Request ID conflict/);
            await expect(payment(db, o.id, 1)).rejects.toThrow(/exceeds/);
            await expect(payment(db, o.id, 10001, 0, 'refund', manager)).rejects.toThrow(/exceeds/);
            await expect(payment(db, o.id, 100, 0, 'refund', member)).rejects.toThrow(/supervisor/);
            await payment(db, o.id, 1000, 0, 'refund', manager);
            const refund = (await db.query<any>('SELECT * FROM veo_order_facts WHERE id=$1', [o.id])).rows[0];
            expect(Number(refund.paid_minor)).toBe(9000); expect(refund.done_date).toEqual(facts.done_date);
            await action(db, manager, 'attribution', { order_id: o.id, seller_id: manager, reason: 'Correct original seller' });
            expect((await db.query<any>('SELECT seller_id FROM veo_orders WHERE id=$1', [o.id])).rows[0].seller_id).toBe(manager);
            expect((await db.query<any>("SELECT count(*)::int AS n FROM veo_audit WHERE action='attribution'")).rows[0].n).toBe(1);
            expect((await db.query<any>("SELECT ('2026-11-05T15:59:59Z'::timestamptz AT TIME ZONE 'Asia/Manila')::date::text AS before,('2026-11-05T16:00:00Z'::timestamptz AT TIME ZONE 'Asia/Manila')::date::text AS after")).rows[0]).toEqual({ before: '2026-11-05', after: '2026-11-06' });
            await expect(db.exec('DELETE FROM veo_payments')).rejects.toThrow(/read-only/);
        } finally { await db.close(); }
    }, 60000);
    it('uses default one, freezes targets, requires both targets and finalizes audited whole-day earnings', async () => {
        const db = await setup();
        try {
            expect((await db.query<any>('SELECT veo_capacity($1,veo_today()) AS r', [member])).rows[0].r.target).toBe(1);
            const immediate = await order(db); await payment(db, immediate.id, 10000);
            let s = (await db.query<any>('SELECT veo_salary($1,veo_today()) AS r', [member])).rows[0].r;
            expect(s).toMatchObject({ closed: 1, done: 1, target: 1, rate: 40, provisional: true });
            expect(s.totals[0].commission_minor).toBe(4000);
            for (const days of [2, 3, 4, 5, 15]) {
                for (let i = 0; i < (days === 15 ? 9 : days === 5 ? 1 : 5); i++) { const o = await order(db); await payment(db, o.id, 10000, days); }
                if (days === 3) expect((await db.query<any>('SELECT veo_capacity($1,veo_today()) AS r', [member])).rows[0].r.target).toBe(1);
            }
            const cap = (await db.query<any>('SELECT veo_capacity($1,veo_today()) AS r', [member])).rows[0].r;
            expect(cap.target).toBe(4);
            expect((await db.query<any>('SELECT veo_target($1,veo_today()) AS n', [member])).rows[0].n).toBe(1);
            await db.exec('SELECT veo_maintenance()');
            expect((await db.query<any>('SELECT count(*)::int AS n FROM veo_salary_days')).rows[0].n).toBeGreaterThan(0);
            const o = await order(db); await payment(db, o.id, 10000, 2);
            await db.exec('SELECT veo_maintenance()');
            expect((await db.query<any>('SELECT count(*)::int AS n FROM veo_salary_adjustments')).rows[0].n).toBeGreaterThan(0);
            await expect(db.exec('UPDATE veo_salary_days SET rate=35')).rejects.toThrow(/read-only/);
            await action(db, member, 'attendance', { active: true, work_date: (await db.query<any>('SELECT (veo_today()+1)::text AS d')).rows[0].d });
            await expect(action(db, member, 'attendance', { active: false, work_date: '2020-01-01' })).rejects.toThrow(/tomorrow/);
        } finally { await db.close(); }
    }, 60000);
    it('rejects ineligible forwarding, deduplicates events, expires photos and preserves launch archives', async () => {
        const db = await setup();
        try {
            const o = await order(db);
            const team = (await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1', [manager])).rows[0].id;
            await action(db, owner, 'mapping', { team_id: team, chat_id: -100123 });
            await action(db, owner, 'mapping', { user_id: member, telegram_user_id: 1234 });
            const tenant = (await db.query<any>('SELECT tenant_id FROM veo_accounts WHERE user_id=$1', [member])).rows[0].tenant_id;
            const photo = { order_id: o.id, object_path: `${tenant}/${member}/photo` };
            await expect(action(db, member, 'submission', photo)).rejects.toThrow(/full verified/);
            await payment(db, o.id, 10000);
            await db.exec(`UPDATE contacts SET pipeline_stage='order_created'`);
            await expect(action(db, member, 'submission', photo)).rejects.toThrow(/Converted/);
            await db.exec(`UPDATE contacts SET pipeline_stage='converted'`);
            const sub = await action(db, member, 'submission', photo);
            await expect(action(db, member, 'submission', { ...photo, object_path: `${photo.object_path}2` })).rejects.toThrow();
            expect((await db.query<any>('SELECT veo_handoff($1) AS r', [sub.id])).rows[0].r.order_id).toBe(o.id);
            await db.exec("UPDATE veo_submissions SET status='blocked'");
            expect((await db.query<any>('SELECT veo_handoff($1) AS r', [sub.id])).rows[0].r).toBeNull();
            await db.exec("UPDATE veo_submissions SET status='queued'");
            await db.exec("UPDATE veo_submissions SET expires_at=now()-interval '1 second'");
            expect((await db.query<any>('SELECT veo_handoff($1) AS r', [sub.id])).rows[0].r).toBeNull();
            await db.query("SELECT veo_ingest_event('veo-page','mid-1',now(),'{}')");
            await db.query("SELECT veo_ingest_event('veo-page','mid-1',now(),'{}')");
            await db.query("SELECT veo_ingest_event('suno-page','mid-2',now(),'{}')");
            expect((await db.query<any>('SELECT count(*)::int AS n FROM veo_event_inbox')).rows[0].n).toBe(1);
            expect((await db.query<any>('SELECT count(*)::int AS n FROM veo_archive_records')).rows[0].n).toBe(1);
            await expect(db.exec('DELETE FROM veo_archive_records')).rejects.toThrow(/read-only/);
            expect((await db.query<any>("SELECT has_function_privilege('anon','veo_action(uuid,text,jsonb)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
        } finally { await db.close(); }
    }, 60000);
});
