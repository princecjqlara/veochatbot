import { beforeAll, afterAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { schemaMigrationPlan } from '../../../scripts/lib/database-migration-safety.mjs';
import { buildEmployeeProfile } from '../veo-employee-profile';
let db: PGlite;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = id(1), page = id(2), tl = id(3), manager = id(4), worker = id(5), peer = id(6), otherManager = id(7), otherTL = id(8), suno = id(9);
let today: string, from: string, to: string, d5: string, d4: string, tenant: string;
const action = async (who: string, kind: string, data: any) => (await db.query<any>('SELECT veo_action($1,$2,$3) r', [who, kind, JSON.stringify(data)])).rows[0].r;
const read = async (actor = owner, employee = worker, first = from, last = to, pg: string | null = null) => (await db.query<any>('SELECT veo_employee_profile($1,$2,$3,$4,$5) r', [actor, employee, first, last, pg])).rows[0].r;
beforeAll(async () => {
    db = await PGlite.create({ extensions: { 'uuid-ossp': uuid_ossp, pg_trgm, vector } });
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA extensions;CREATE SCHEMA cron;
        CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text);CREATE TABLE cron.job_run_details(end_time timestamptz);
        CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS 'INSERT INTO cron.job(jobname) VALUES($1) RETURNING jobid';
        CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobid=$1 RETURNING true';`);
    for (const migration of schemaMigrationPlan()) await db.exec(migration.sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;/g, '-- scheduler stub'));
    await db.exec(`INSERT INTO users(id,email,name) VALUES('${owner}','owner@example.com','CJ Lara');
        INSERT INTO pages(id,fb_page_id,name,access_token) VALUES('${page}','111','VEO','test'),('${suno}','222','Suno','test');
        INSERT INTO user_pages(user_id,page_id) VALUES('${owner}','${page}');`);
    await db.query('SELECT veo_launch($1,$2)', [owner, [page]]);
    await db.exec("UPDATE veo_tenants SET launch_at=(veo_today()-20)::timestamp AT TIME ZONE 'Asia/Manila'");
    tenant = (await db.query<any>('SELECT tenant_id FROM veo_accounts WHERE user_id=$1', [owner])).rows[0].tenant_id;
    for (const [user, role, parent, name] of [[tl, 'team_leader', owner, 'Leader'], [otherTL, 'team_leader', owner, 'Other leader'], [manager, 'manager', tl, 'Selling manager'], [otherManager, 'manager', otherTL, 'Other manager'], [worker, 'member', manager, 'Employee A'], [peer, 'member', manager, 'Employee B']]) {
        await action(owner, 'create_account', { user_id: user, role, parent_id: parent, name, email: `${user}@example.org`, password_hash: 'x'.repeat(40), page_ids: [page] });
    }
    await db.exec("UPDATE veo_accounts SET enrolled_at=(veo_today()-10)::timestamp AT TIME ZONE 'Asia/Manila'");
    ({ today, from, to, d5, d4 } = (await db.query<any>('SELECT veo_today()::text today,(veo_today()-6)::text AS "from",(veo_today()-1)::text AS "to",(veo_today()-5)::text d5,(veo_today()-4)::text d4')).rows[0]);
    for (let n = 20; n <= 26; n++) await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage) VALUES($1,$2,$3,$3,'converted')", [id(n), page, `client-${n}`]);
    const order = async (seller: string, contact: number, key: number, amount: number) => action(seller, 'order', { request_id: id(key), seller_id: seller, page_id: page, contact_id: id(contact), description: 'Verified video order', total_minor: amount, currency: 'PHP' });
    const payment = async (seller: string, orderId: string, key: number, kind: string, amount: number, at: string) => action(seller, 'payment', { request_id: id(key), order_id: orderId, kind, amount_minor: amount, reference: `reference-${key}`, confirmed: true, occurred_at: at });
    const first = await order(worker, 20, 100, 10000);
    await payment(worker, first.id, 101, 'deposit', 4000, `${from}T23:59:00+08:00`);
    await payment(worker, first.id, 102, 'balance', 6000, `${d5}T00:01:00+08:00`);
    const full = await order(worker, 21, 103, 20000);
    await payment(worker, full.id, 104, 'full', 20000, `${d5}T12:00:00+08:00`);
    const waiting = await order(worker, 22, 105, 10000);
    await payment(worker, waiting.id, 106, 'deposit', 3000, `${d4}T12:00:00+08:00`);
    for (let n = 0; n < 3; n++) {
        const o = await order(peer, 24 + n, 110 + n * 2, 100);
        await payment(peer, o.id, 111 + n * 2, 'full', 100, `${d5}T13:00:00+08:00`);
    }
    for (const contact of [20, 21, 23]) {
        const at = `${from}T09:00:00+08:00`;
        await db.query("INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,created_at) VALUES($1,$2,'client_assignment',$3,$4,$5)", [tenant, owner, id(contact), JSON.stringify({ user_id: worker, claimed_at: at }), at]);
        await db.query('INSERT INTO veo_client_claims(contact_id,tenant_id,page_id,user_id,claimed_at) VALUES($1,$2,$3,$4,$5)', [id(contact), tenant, page, worker, at]);
    }
    await db.query("INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,created_at) VALUES($1,$2,'client_assignment',$3,$4,$5)", [tenant, owner, id(20), JSON.stringify({ user_id: peer, claimed_at: `${d4}T09:00:00+08:00` }), `${d4}T09:00:00+08:00`]);
    await db.query('UPDATE veo_client_claims SET user_id=$1,claimed_at=$2 WHERE contact_id=$3', [peer, `${d4}T09:00:00+08:00`, id(20)]);
    for (const [contact, at, mid] of [[20, `${from}T10:00:00+08:00`, 'owned-in'], [21, `${d5}T10:00:00+08:00`, 'unattributed-in'], [23, `${d5}T10:00:00+08:00`, 'unanswered-in'], [20, `${d4}T10:00:00+08:00`, 'reassigned-in']]) {
        await db.query("INSERT INTO veo_calendar_messages VALUES($1,$2,$3,'in',$4,'facebook')", [page, mid, `client-${contact}`, at]);
    }
    await db.query("INSERT INTO outbound_message_events(page_id,contact_id,message_id,source_type,actor_user_id,sent_at) VALUES($1,$2,'manual-out','manual',$3,$4)", [page, id(20), worker, `${from}T11:00:00+08:00`]);
    await db.query("INSERT INTO veo_calendar_messages VALUES($1,'unknown-out','client-21','out',$2,'facebook')", [page, `${d5}T11:00:00+08:00`]);
    await db.query("INSERT INTO outbound_message_events(page_id,contact_id,message_id,source_type,actor_user_id,sent_at) VALUES($1,$2,'bot-out','chatbot',$3,$4)", [page, id(23), worker, `${d5}T11:00:00+08:00`]);
    await db.query("INSERT INTO veo_calendar_message_coverage VALUES($1,(veo_today()-20)::timestamp AT TIME ZONE 'Asia/Manila') ON CONFLICT(page_id) DO UPDATE SET capture_from=EXCLUDED.capture_from", [page]);
    await db.query("INSERT INTO veo_attendance(user_id,work_date,active,updated_by,source) VALUES($1,$2,true,$3,'telegram'),($1,$4,false,$3,'workspace')", [worker, d5, owner, d4]);
}, 60000);
afterAll(async () => { await db?.close(); });

it('adds first-assignment client counts and payment versus production turnaround without changing salary',async()=>{
    await db.exec('BEGIN');try{
        const first=(await db.query<any>('SELECT id FROM veo_orders WHERE request_id=$1',[id(100)])).rows[0].id;
        const second=(await db.query<any>('SELECT id FROM veo_orders WHERE request_id=$1',[id(103)])).rows[0].id;
        await db.query(`INSERT INTO veo_order_work(order_id,assignee_id,status,completed_work_at,updated_by) VALUES($1,$3,'ready_waiting_payment',$4,$5),($2,$3,'ready_waiting_payment',$6,$5)
          ON CONFLICT(order_id) DO UPDATE SET assignee_id=EXCLUDED.assignee_id,status=EXCLUDED.status,completed_work_at=EXCLUDED.completed_work_at`,[first,second,worker,`${d5}T01:59:00+08:00`,owner,`${d5}T18:00:00+08:00`]);
        const raw=await read(owner,worker,from,to,page),p=buildEmployeeProfile(raw).performance!;
        expect(p.current_clients).toBe(2);expect(p.ever_assigned_clients).toBe(3);expect(p.new_clients).toBe(3);
        expect(p.days.find((day:any)=>day.work_date===from).new_clients).toBe(3);
        expect(p.cd_turnaround).toMatchObject({count:2,fastest:{hours:0},slowest:{hours:2/60}});
        expect(p.video_turnaround).toMatchObject({count:2,mean_hours:4,fastest:{hours:2},slowest:{hours:6}});
        expect(p.completed_days).toBe(6);expect(p.average_done).toBe(2/6);
        const narrower=buildEmployeeProfile(await read(owner,worker,d5,to,page)).performance!;expect(narrower.new_clients).toBe(0);
        const before=p.ever_assigned_clients;
        await db.query("INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,created_at) VALUES($1,$2,'client_assignment',$3,$4,$5)",[tenant,owner,id(20),JSON.stringify({user_id:worker,claimed_at:`${to}T09:00:00+08:00`}),`${to}T09:00:00+08:00`]);
        expect(buildEmployeeProfile(await read()).performance!.ever_assigned_clients).toBe(before);
    }finally{await db.exec('ROLLBACK');}
});

it('conserves allocated ad-cost cents between sellers and rejects stale, missing and unallocatable costs',async()=>{
    await db.exec('BEGIN');try{
        await db.query("INSERT INTO ad_daily_spend(page_id,ad_id,account_id,spend_date,currency,account_timezone,pht_aligned,amount,checked_at) VALUES($1,'91','92',$2,'PHP','Asia/Manila',true,10.01,now())",[page,d5]);
        await db.query("INSERT INTO veo_ad_spend_coverage VALUES($1,$2,'PHP',1001,1,1,now(),true,true)",[page,d5]);
        const a=buildEmployeeProfile(await read(owner,worker,d5,d5,page)).performance!,b=buildEmployeeProfile(await read(owner,peer,d5,d5,page)).performance!;
        expect(a.completed_totals[0].ad_cost_minor+b.completed_totals[0].ad_cost_minor).toBe(1001);
        expect(a.completed_totals[0].net_profit_minor).toBe(a.completed_totals[0].gross_profit_minor-a.completed_totals[0].ad_cost_minor);
        await db.query("UPDATE ad_daily_spend SET checked_at=now()+interval '1 second' WHERE page_id=$1",[page]);
        expect(buildEmployeeProfile(await read(owner,worker,d5,d5,page)).performance!.completed_totals[0].net_profit_minor).toBeNull();
        await db.query("INSERT INTO ad_daily_spend(page_id,ad_id,account_id,spend_date,currency,account_timezone,pht_aligned,amount,checked_at) VALUES($1,'93','92',$2,'PHP','Asia/Manila',true,5,now())",[page,d4]);
        await db.query("INSERT INTO veo_ad_spend_coverage VALUES($1,$2,'PHP',500,1,1,now(),true,true)",[page,d4]);
        expect(buildEmployeeProfile(await read(owner,worker,d4,d4,page)).performance!.completed_totals[0].net_profit_minor).toBeNull();
        await db.query("UPDATE veo_ad_spend_coverage SET amount_minor=0 WHERE page_id=$1 AND spend_date=$2",[page,d4]);
        await db.query("UPDATE ad_daily_spend SET amount=0 WHERE page_id=$1 AND spend_date=$2",[page,d4]);
        expect(buildEmployeeProfile(await read(owner,worker,d4,d4,page)).performance!.completed_totals[0].ad_cost_minor).toBe(0);
    }finally{await db.exec('ROLLBACK');}
});

it('keeps overall ranking independent of the selected Page and never reveals peer ranks to members',async()=>{
    const full=await read(),filtered=await read(owner,worker,from,to,page);
    expect(filtered.performance_inputs.overall_ranking).toEqual(full.performance_inputs.overall_ranking);
    expect(filtered.performance_inputs.page_rankings.find((row:any)=>row.page_id===page).rank).toBe(2);
    const personal=await read(worker);expect(personal.performance_inputs.overall_ranking.rank).toBeNull();expect(personal.performance_inputs.page_rankings.every((row:any)=>row.rank===null&&row.peers===null)).toBe(true);
});

it('combines salary, zero-sales employment dates, capacity, attendance and full-peer ranking', async () => {
    const r = buildEmployeeProfile(await read());
    expect(r.employee.name).toBe('Employee A'); expect(r.days).toHaveLength(6);
    expect(r.summary).toMatchObject({ closed: 3, done: 2, cd_cohort: 3, cd_cohort_done: 2, cd_to_dd_rate: 2 / 3, waiting_payment: 1 });
    expect(r.ranking).toEqual({ rank: 2, peers: 4 }); // A selected employee must not become #1.
    expect(r.days.find((d: any) => d.work_date === d5)).toMatchObject({ closed: 1, done: 2, rate: 40, rank: 2, attendance: { active: true, source: 'telegram' } });
    expect(r.attendance).toEqual({ active: 1, inactive: 1, unknown: 4 });
    expect(r.totals[0]).toMatchObject({ currency: 'PHP', gross_minor: 30000, net_minor: 30000, salary_minor: 12000, average_daily_gross_minor: 5000, average_daily_salary_minor: 2000, average_active_day_salary_minor: 12000 });
    expect(r.capacity).toMatchObject({ target: 1, observed_max_done: 2, observed_max_closed: 1 });
});
it('uses a Closed cohort with eventual completion and exact Philippine-midnight timing', async () => {
    const r = buildEmployeeProfile(await read(owner, worker, from, from));
    expect(r.summary).toMatchObject({ closed: 1, done: 0, cd_cohort: 1, cd_cohort_done: 1, cd_to_dd_rate: 1 });
    expect(Number(r.summary.cd_to_dd_hours_mean)).toBeCloseTo(2 / 60);
    expect(Number(r.summary.cd_to_dd_hours_median)).toBeCloseTo(2 / 60);
    expect(r.days[0].rate).toBe(35);
});
it('attributes conversion and manual replies only during recorded ownership', async () => {
    const r = buildEmployeeProfile(await read());
    expect(r.summary).toMatchObject({ assigned_cohort: 3, assigned_cohort_converted: 2, conversion_rate: 2 / 3, reply_client_days: 3, answered_client_days: 1, unattributed_reply_client_days: 1, reply_rate: 1 / 3 });
    expect(r.reply_coverage.complete).toBe(true);
    expect(r.days.find((d: any) => d.work_date === d4).replies.incoming_clients).toBe(0);
    expect(r.clients.find((c: any) => c.contact_id === id(20)).currently_assigned).toBe(false);
});
it('keeps continuous ownership when the same employee assignment is saved again', async () => {
    await db.query("INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,created_at) VALUES($1,$2,'client_assignment',$3,$4,$5)", [tenant, owner, id(20), JSON.stringify({ user_id: worker, claimed_at: `${from}T10:30:00+08:00` }), `${from}T10:30:00+08:00`]);
    const r = buildEmployeeProfile(await read());
    expect(r.summary).toMatchObject({ assigned_cohort: 3, assigned_cohort_converted: 2, answered_client_days: 1, reply_client_days: 3 });
});
it('keeps unrelated shared-Page inquiries out of employee client history', async () => {
    const before = await read();
    await db.query("INSERT INTO contacts(page_id,psid,name,pipeline_stage) SELECT $1,'unassigned-'||n,'Unassigned client '||n,'new' FROM generate_series(1,1000) n", [page]);
    const after = await read();
    expect(after.client_count).toBe(before.client_count);
    expect(after.clients.map((c: any) => c.contact_id).sort()).toEqual(before.clients.map((c: any) => c.contact_id).sort());
    expect(after.summary.assigned_cohort).toBe(before.summary.assigned_cohort);
});
it('preserves branch, date and salary results across mixed requests on a pooled generic-plan connection', async () => {
    await db.exec("SET plan_cache_mode='force_generic_plan'");
    try {
        for (const actor of [owner, tl, manager, owner, manager, tl]) {
            const r = await read(actor);
            expect(r.summary).toMatchObject({ closed: 3, done: 2, cd_cohort: 3, cd_cohort_done: 2 });
            expect(r.days.find((d: any) => d.work_date === d5)).toMatchObject({ target: 1, rate: 40 });
            expect(r.ranking.rank).toBe(2);
        }
        await expect(read(otherTL)).rejects.toThrow(/access denied/);
    } finally { await db.exec('RESET plan_cache_mode'); }
});
it('enforces member self, supervisor branch, current Page grants and private RPC access', async () => {
    await expect(read(worker, peer)).rejects.toThrow(/access denied/);
    await expect(read(otherTL, worker)).rejects.toThrow(/access denied/);
    await expect(read(tl, worker, from, to, suno)).rejects.toThrow(/access denied/);
    const personal = await read(worker); expect(personal.ranking.rank).toBeNull(); expect(personal.ranking.peers).toBeNull();
    await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2', [tl, page]);
    try { const revoked = await read(tl); expect(revoked.summary.closed).toBe(0); expect(revoked.clients).toHaveLength(0); expect(revoked.days.every((d: any) => d.totals.length === 0)).toBe(true); }
    finally { await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [tl, page]); }
    expect((await db.query<any>("SELECT has_function_privilege('anon','veo_employee_profile(uuid,uuid,date,date,uuid)','EXECUTE') OR has_function_privilege('authenticated','veo_employee_profile(uuid,uuid,date,date,uuid)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
    expect(JSON.stringify(await read())).not.toContain('Suno');
});
it('retains former-employee history and rejects dates before launch or beyond 93 dates', async () => {
    await db.query('UPDATE veo_accounts SET active=false,departed_at=$2 WHERE user_id=$1', [worker, `${to}T12:00:00+08:00`]);
    try { const r = await read(); expect(r.employee.active).toBe(false); expect(r.summary.done).toBe(2); expect(r.days).toHaveLength(6); }
    finally { await db.query('UPDATE veo_accounts SET active=true,departed_at=NULL WHERE user_id=$1', [worker]); }
    await expect(read(owner, worker, '2020-01-01', to)).rejects.toThrow(/93 Philippine dates/);
    const r = buildEmployeeProfile(await read(owner, worker, today, today));
    expect(r.completed_days).toBe(0); expect(r.summary.cd_to_dd_rate).toBeNull(); expect(r.summary.reply_rate).toBeNull();
});
it('keeps historical attendance provenance and switches a supervisor replacement to workspace', async () => {
    await db.query("INSERT INTO veo_attendance(user_id,work_date,active,updated_by,source) VALUES($1,$2,true,$3,'telegram')", [worker, today, owner]);
    await action(manager, 'attendance_today', { user_id: worker, active: false });
    expect((await read(owner, worker, today, today)).days[0].attendance).toMatchObject({ active: false, source: 'workspace' });
    expect((await read()).days.find((d: any) => d.work_date === d5).attendance.source).toBe('telegram');
});
it('rejects a worker from a different tenant even when a Page is shared in the legacy grants', async () => {
    const stranger = id(300), foreignTenant = id(301), foreignWorker = id(302);
    await db.exec(`INSERT INTO users(id,email,name) VALUES('${stranger}','foreign@example.org','Foreign owner'),('${foreignWorker}','foreign-worker@example.org','Foreign worker');
        INSERT INTO veo_tenants(id,owner_id,launch_at) VALUES('${foreignTenant}','${stranger}',now()-interval '20 days');
        INSERT INTO veo_accounts(user_id,tenant_id,role,parent_id) VALUES('${stranger}','${foreignTenant}','owner',NULL),('${foreignWorker}','${foreignTenant}','member','${stranger}');
        INSERT INTO user_pages(user_id,page_id) VALUES('${stranger}','${page}'),('${foreignWorker}','${page}');`);
    await expect(read(owner, foreignWorker)).rejects.toThrow(/access denied/);
    await expect(read(stranger, worker)).rejects.toThrow(/access denied/);
});
it('preserves gross order value and adjusts commission from verified refunds', async () => {
    const order = (await db.query<any>('SELECT id FROM veo_orders WHERE request_id=$1', [id(100)])).rows[0].id;
    await action(owner, 'payment', { request_id: id(400), order_id: order, kind: 'refund', amount_minor: 1000, reference: 'verified-refund-400', reason: 'Verified partial refund', confirmed: true, occurred_at: `${to}T12:00:00+08:00` });
    const r = buildEmployeeProfile(await read());
    expect(r.summary.done).toBe(2); expect(r.totals[0]).toMatchObject({ gross_minor: 30000, net_minor: 29000, salary_minor: 11600 });
});
it('conserves the whole-day commission across Page profiles and preserves all-Page rate qualification', async () => {
    const second = id(500), client = id(501);
    await db.query("INSERT INTO pages(id,fb_page_id,name,access_token,veo_enabled,veo_tenant_id) VALUES($1,'333','VEO second','test',true,$2)", [second, tenant]);
    for (const user of [owner, tl, manager, worker]) await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [user, second]);
    await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage) VALUES($1,$2,'second-client','Second Page client','converted')", [client, second]);
    const o = await action(worker, 'order', { request_id: id(502), seller_id: worker, page_id: second, contact_id: client, description: 'Small order', total_minor: 1, currency: 'PHP' });
    await action(worker, 'payment', { request_id: id(503), order_id: o.id, kind: 'full', amount_minor: 1, reference: 'one-cent-order', confirmed: true, occurred_at: `${d5}T12:01:00+08:00` });
    const all = buildEmployeeProfile(await read()), first = buildEmployeeProfile(await read(owner, worker, from, to, page)), next = buildEmployeeProfile(await read(owner, worker, from, to, second));
    expect(first.totals[0].salary_minor + next.totals[0].salary_minor).toBe(all.totals[0].salary_minor);
    expect(first.totals[0].gross_minor + next.totals[0].gross_minor).toBe(all.totals[0].gross_minor);
    expect(next.days.find((d: any) => d.work_date === d5)).toMatchObject({ qualified_closed: 2, qualified_done: 3, closed: 1, done: 1, rate: 40 });
    expect(first.clients.some((c: any) => c.page_id === second)).toBe(false);
});
