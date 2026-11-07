import { beforeAll, afterAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { schemaMigrationPlan } from '../../../scripts/lib/database-migration-safety.mjs';
let db: PGlite;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = id(1), page = id(2), client = id(3), manager = id(4), foreign = id(5);
let today: string, earlier: string;
const action = async (who: string, kind: string, body: any) => (await db.query<any>('SELECT veo_action($1,$2,$3) AS r', [who, kind, JSON.stringify(body)])).rows[0].r;
beforeAll(async () => {
    db = await PGlite.create({ extensions: { 'uuid-ossp': uuid_ossp, pg_trgm, vector } });
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA extensions;CREATE SCHEMA cron;
        CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text);CREATE TABLE cron.job_run_details(end_time timestamptz);
        CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS 'INSERT INTO cron.job(jobname) VALUES($1) RETURNING jobid';
        CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobid=$1 RETURNING true';`);
    for (const migration of schemaMigrationPlan()) await db.exec(migration.sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;/g, '-- scheduler stub'));
    await db.exec(`INSERT INTO users(id,email,name) VALUES('${owner}','owner@example.com','CJ Lara');
        INSERT INTO pages(id,fb_page_id,name,access_token) VALUES('${page}','111','VEO','test'),('${foreign}','222','Suno','test');
        INSERT INTO user_pages(user_id,page_id) VALUES('${owner}','${page}');
        INSERT INTO contacts(id,page_id,psid,name,first_interaction_at,pipeline_stage) VALUES('${client}','${page}','client','Client',now()-interval '2 days','converted');
        INSERT INTO contacts(id,page_id,psid,name,first_interaction_at,pipeline_stage,pipeline_stage_updated_at) VALUES('${id(6)}','${page}','old-client','Historical client',now()-interval '40 days','converted',now()-interval '35 days');
        INSERT INTO contact_purchases(id,request_id,page_id,contact_id,description,total_minor,currency,purchased_at,recorded_by,created_at) VALUES('${id(20)}','${id(20)}','${page}','${id(6)}','Retained order',10000,'PHP',now()-interval '35 days','${owner}',now()-interval '40 days');
        INSERT INTO contact_verified_payments(request_id,page_id,contact_id,purchase_id,kind,amount_minor,currency,occurred_at,reference,verified_by) VALUES('${id(21)}','${page}','${id(6)}','${id(20)}','deposit',3000,'PHP',now()-interval '35 days','retained-deposit','${owner}'),('${id(22)}','${page}','${id(6)}','${id(20)}','balance',7000,'PHP',now()-interval '30 days','retained-balance','${owner}');`);
    await db.query('SELECT veo_launch($1,$2)', [owner, [page]]);
    await db.exec("UPDATE veo_tenants SET launch_at=now()-interval '10 days'");
    await action(owner, 'create_account', { user_id: manager, parent_id: owner, role: 'manager', name: 'Seller', email: 'manager@example.org', password_hash: 'x'.repeat(40), page_ids: [page] });
    const dates = (await db.query<any>('SELECT veo_today()::text AS today,(veo_today()-2)::text AS earlier')).rows[0]; today = dates.today; earlier = dates.earlier;
}, 60000);
afterAll(async () => { await db?.close(); });
it('preserves first-inquiry cohorts while exact paid-order salary stays on the actual completion date', async () => {
    const o = await action(manager, 'order', { request_id: id(10), seller_id: manager, page_id: page, contact_id: client, description: 'Video', total_minor: 203, currency: 'PHP' });
    await action(manager, 'payment', { request_id: id(11), order_id: o.id, kind: 'deposit', confirmed: true, reference: 'deposit', amount_minor: 50, occurred_at: `${earlier}T12:00:00+08:00` });
    await action(manager, 'payment', { request_id: id(12), order_id: o.id, kind: 'balance', confirmed: true, reference: 'balance', amount_minor: 153, occurred_at: new Date(Date.now() - 1000).toISOString() });
    const report = (await db.query<any>('SELECT veo_calendar_inputs($1,$2,$3,$2) AS r', [owner, earlier, today])).rows[0].r;
    expect(report.leads).toHaveLength(1); expect(report.orders[0]).toMatchObject({ financial_source: 'workspace', paid_minor: 203, commission_minor: 71, closed_date: earlier, done_date: today });
    expect(report.cash).toHaveLength(2);
    expect(report.selected_clients[0].id).toBe(client);
    expect(JSON.stringify(report)).not.toContain('Suno');
});
it('retains historical receipts and later completions without inventing archived commission', async () => {
    const old = (await db.query<any>("SELECT (first_interaction_at AT TIME ZONE 'Asia/Manila')::date::text AS day FROM contacts WHERE id=$1", [id(6)])).rows[0].day;
    const r = (await db.query<any>('SELECT veo_calendar_inputs($1,$2,$2,$2) AS r', [owner, old])).rows[0].r;
    expect(r.leads[0].id).toBe(id(6)); expect(r.orders[0]).toMatchObject({ paid_minor: 10000, commission_minor: null, financial_source: 'retained' });
    expect(r.cash.reduce((n: number, p: any) => n + Number(p.amount_minor), 0)).toBe(10000);
});
it('allocates the exact whole-day commission across Pages and individual orders', async () => {
    const secondPage = id(30), secondClient = id(31), tenant = (await db.query<any>('SELECT tenant_id FROM veo_accounts WHERE user_id=$1', [owner])).rows[0].tenant_id;
    await db.query("INSERT INTO pages(id,fb_page_id,name,access_token,veo_enabled,veo_tenant_id) VALUES($1,'333','VEO second','test',true,$2)", [secondPage, tenant]);
    await db.exec(`INSERT INTO user_pages(user_id,page_id) VALUES('${owner}','${secondPage}'),('${manager}','${secondPage}'); INSERT INTO contacts(id,page_id,psid,name,pipeline_stage) VALUES('${secondClient}','${secondPage}','client-2','Second client','converted')`);
    for (const [pg, ct, key] of [[page, client, 32], [secondPage, secondClient, 34]] as const) {
        const o = await action(manager, 'order', { request_id: id(key), seller_id: manager, page_id: pg, contact_id: ct, description: 'Small order', total_minor: 1, currency: 'PHP' });
        await action(manager, 'payment', { request_id: id(key + 1), order_id: o.id, kind: 'full', amount_minor: 1, reference: `paid-${key}`, confirmed: true, occurred_at: new Date(Date.now() - 500).toISOString() });
    }
    const byPage = (await db.query<any>('SELECT page_id,sum(commission_minor)::int AS commission FROM veo_calendar_order_values WHERE financial_source=$1 AND done_date=$2 GROUP BY page_id', ['workspace', today])).rows;
    for (const row of byPage) {
        const r = (await db.query<any>('SELECT veo_finance_days($1,$2,$2,$3) AS r', [owner, today, row.page_id])).rows[0].r;
        expect(row.commission).toBe(r.days.find((d: any) => d.user_id === manager).totals[0].commission_minor);
    }
    expect(byPage.reduce((n, p) => n + p.commission, 0)).toBe(82);
});
it('deduplicates messaging and standby metadata and counts replies by their actual Philippine date', async () => {
    const payload = (out = false) => ({ entry: [{ id: '111', messaging: [{ sender: { id: out ? '111' : 'client' }, recipient: { id: out ? 'client' : '111' }, message: { mid: out ? 'out' : 'in' } }] }] });
    await db.query('SELECT veo_calendar_capture_message($1,$2,$3)', [page, `${earlier}T23:59:00+08:00`, JSON.stringify(payload())]);
    await db.query('SELECT veo_calendar_capture_message($1,$2,$3)', [page, `${earlier}T23:59:00+08:00`, JSON.stringify(payload())]);
    await db.query('SELECT veo_calendar_capture_message($1,$2,$3)', [page, `${earlier}T23:59:30+08:00`, JSON.stringify(payload(true))]);
    const report = (await db.query<any>('SELECT veo_calendar_inputs($1,$2,$3,$2) AS r', [owner, earlier, today])).rows[0].r;
    expect(report.messages[0]).toMatchObject({ inbound: 1, answered: 1 });
    expect((await db.query<any>('SELECT count(*)::int AS n FROM veo_calendar_messages')).rows[0].n).toBe(2);
    await db.query("UPDATE veo_calendar_messages SET occurred_at=occurred_at+interval '1 minute' WHERE direction='out'");
    const after = (await db.query<any>('SELECT veo_calendar_inputs($1,$2,$3,$2) AS r', [owner, earlier, today])).rows[0].r;
    expect(after.messages[0].answered).toBe(0);
});
it('denies manager access, foreign Pages and anonymous execution without creating past targets', async () => {
    await expect(db.query('SELECT veo_calendar_inputs($1,$2,$3,$2)', [manager, earlier, today])).rejects.toThrow(/Owner/);
    await expect(db.query('SELECT veo_calendar_inputs($1,$2,$3,$2,$4)', [owner, earlier, today, foreign])).rejects.toThrow(/Page access/);
    expect((await db.query<any>("SELECT has_function_privilege('anon','veo_calendar_inputs(uuid,date,date,date,uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
    const before = (await db.query<any>('SELECT count(*)::int AS n FROM veo_daily_targets WHERE work_date<veo_today()')).rows[0].n;
    await db.query("SELECT veo_calendar_inputs($1,'2020-01-01','2020-01-31','2020-01-01')", [owner]);
    expect((await db.query<any>('SELECT count(*)::int AS n FROM veo_daily_targets WHERE work_date<veo_today()')).rows[0].n).toBe(before);
});
it('requires full source coverage for spend, including zero-ad Pages and newer ledger changes', async () => {
    await db.query("INSERT INTO ad_daily_spend(page_id,ad_id,account_id,spend_date,currency,account_timezone,pht_aligned,amount,report_complete,checked_at) VALUES($1,'123','99',$2,'PHP','Asia/Manila',true,10,true,now()-interval '1 hour')", [page, earlier]);
    const read = async () => (await db.query<any>('SELECT veo_calendar_spend($1,$2,$2) AS r', [[page], earlier])).rows[0].r[0];
    expect(await read()).toMatchObject({ amount_minor: 1000, complete: false });
    await db.query("INSERT INTO veo_ad_spend_coverage VALUES($1,$2,'PHP',1000,1,27,now(),true,true)", [page, earlier]);
    expect(await read()).toMatchObject({ amount_minor: 1000, complete: true, accounts_checked: 27 });
    await db.query("UPDATE ad_daily_spend SET amount=11,checked_at=now()+interval '1 second' WHERE page_id=$1", [page]);
    expect(await read()).toMatchObject({ amount_minor: 1100, complete: false });
    await db.query("INSERT INTO veo_ad_spend_coverage VALUES($1,$2,'PHP',0,0,27,now(),true,true)", [foreign, earlier]);
    expect((await db.query<any>('SELECT veo_calendar_spend($1,$2,$2) AS r', [[foreign], earlier])).rows[0].r[0]).toMatchObject({ amount_minor: 0, complete: true });
    expect((await db.query<any>("SELECT has_table_privilege('authenticated','veo_ad_spend_coverage','SELECT') AS allowed")).rows[0].allowed).toBe(false);
});
it('extracts from retained launch messages with leases and preserves manual demographic corrections', async () => {
    const payload = { entry: [{ id: '111', messaging: [{ sender: { id: 'client' }, recipient: { id: '111' }, message: { mid: 'demographic-source', text: 'Age: 34\nCity: Manila' } }] }] };
    await db.query("INSERT INTO veo_event_inbox(event_key,page_id,occurred_at,payload) VALUES('demo-event',$1,now(),$2)", [page, JSON.stringify(payload)]);
    await db.query("UPDATE veo_event_inbox SET status='done' WHERE event_key='demo-event'");
    await db.query("SELECT veo_demographic_action($1,$2,'refresh')", [owner, client]);
    const job = (await db.query<any>('SELECT * FROM veo_demographic_claim(1)')).rows[0]; expect(job.contact_id).toBe(client);
    const sources = (await db.query<any>('SELECT veo_demographic_sources($1,$2) r', [client, job.claim_token])).rows[0].r;
    expect(sources.messages[0]).toMatchObject({ id: 'demographic-source', text: 'Age: 34\nCity: Manila', sender: 'customer' });
    await db.query("SELECT veo_demographic_action($1,$2,'refresh')", [owner, client]); // A newer request must survive this lease.
    const facts = [{ field: 'age', value: '34', evidence: [{ message_id: 'demographic-source', quote: 'Age: 34', at: new Date().toISOString() }] }, { field: 'city', value: 'Manila', evidence: [{ message_id: 'demographic-source', quote: 'City: Manila', at: new Date().toISOString() }] }];
    expect((await db.query<any>('SELECT veo_demographic_finish($1,$2,$3,$4) r', [client, job.claim_token, JSON.stringify(facts), 'a'.repeat(64)])).rows[0].r).toBe(true);
    expect((await db.query<any>('SELECT status FROM veo_contact_demographics WHERE contact_id=$1', [client])).rows[0].status).toBe('queued');
    await db.query("SELECT veo_demographic_action($1,$2,'correct',$3)", [manager, client, JSON.stringify({ city: 'Cebu', gender: '' })]);
    const data = (await db.query<any>('SELECT veo_demographic_access($1,$2) r', [owner, client])).rows[0].r;
    expect(data.manual_fields).toMatchObject({ city: 'Cebu', gender: '' }); expect(data.ai_demographics.city).toBe('Manila');
    const calendar = (await db.query<any>('SELECT veo_calendar_inputs($1,$2,$3,$2) r', [owner, earlier, today])).rows[0].r;
    expect(calendar.selected_clients[0].ai_demographics.age).toBe('34');
    expect((await db.query<any>("SELECT count(*)::int n FROM veo_audit WHERE action='demographics_corrected'")).rows[0].n).toBe(1);
});
it('blocks demographic access outside current Pages and keeps demographic tables private', async () => {
    await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2', [manager, page]);
    await expect(db.query('SELECT veo_demographic_access($1,$2)', [manager, client])).rejects.toThrow(/denied/);
    expect((await db.query<any>("SELECT has_function_privilege('anon','veo_demographic_action(uuid,uuid,text,jsonb)','EXECUTE') f,has_table_privilege('authenticated','veo_contact_demographics','SELECT') t")).rows[0]).toEqual({ f: false, t: false });
    await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [manager, page]);
});
it('reads historical and current Page inputs in a read-only transaction without competing snapshot writes', async () => {
    await db.exec('BEGIN READ ONLY');
    try {
        const current = (await db.query<any>('SELECT veo_calendar_inputs($1,$2,$3,$2) r', [owner, earlier, today])).rows[0].r;
        expect(current.pages.some((p: any) => p.id === page)).toBe(true);
        await db.query("SELECT veo_calendar_inputs($1,'2020-01-01','2020-01-31','2020-01-01')", [owner]);
    } finally { await db.exec('ROLLBACK'); }
    expect((await db.query<any>('SELECT veo_calendar_prepare($1) r', [owner])).rows[0].r).toBe(true);
    await expect(db.query('SELECT veo_calendar_prepare($1)', [manager])).rejects.toThrow(/denied/);
});
it('requests additional profile details idempotently, preserves proof and manual corrections, and leaves finance untouched', async () => {
    const count = async () => (await db.query<any>('SELECT (SELECT count(*) FROM veo_payments)::int AS payments,(SELECT count(*) FROM veo_orders)::int AS orders')).rows[0];
    const before = await count();
    const fields = JSON.stringify([{ key: 'delivery_deadline', label: 'Delivery deadline' }]);
    await db.query('SELECT veo_profile_detail_request($1,$2,$3)', [manager, client, fields]);
    await db.query('SELECT veo_profile_detail_request($1,$2,$3)', [manager, client, fields]);
    const current = (await db.query<any>('SELECT veo_profile_detail_access($1,$2) r', [owner, client])).rows[0].r;
    expect(current.requested_fields).toHaveLength(1); expect(current.branch_worker_ids).toContain(manager);
    expect(current.manual_fields.city).toBe('Cebu');
    const payload = { entry: [{ id: '111', messaging: [{ sender: { id: 'client' }, recipient: { id: '111' }, message: { mid: 'profile-purpose-source', text: 'I need Video ads. Deliver by Friday.' } }] }] };
    await db.query("INSERT INTO veo_event_inbox(event_key,page_id,occurred_at,payload) VALUES('profile-purpose-event',$1,now(),$2)", [page, JSON.stringify(payload)]);
    await db.query("UPDATE veo_event_inbox SET status='done' WHERE event_key='profile-purpose-event'");
    const job = (await db.query<any>('SELECT * FROM veo_demographic_claim(1)')).rows[0]; expect(job.contact_id).toBe(client);
    const sources = (await db.query<any>('SELECT veo_demographic_sources($1,$2) r', [client, job.claim_token])).rows[0].r;
    expect(sources.requested_fields[0]).toEqual({ key: 'delivery_deadline', label: 'Delivery deadline' }); expect(Array.isArray(sources.chatbot_fields)).toBe(true);
    expect(sources.messages.some((m: any) => m.id === 'profile-purpose-source' && m.text.includes('Video ads'))).toBe(true);
    await db.query('SELECT veo_profile_detail_request($1,$2,$3)', [manager, client, JSON.stringify([{ key: 'video_style', label: 'Preferred video style' }])]);
    await db.query('SELECT veo_demographic_finish($1,$2,$3,$4)', [client, job.claim_token, JSON.stringify([{ field: 'buying_purpose', value: 'Video ads', evidence: [{ message_id: 'profile-purpose-source', quote: 'I need Video ads.', at: new Date().toISOString() }] }]), 'b'.repeat(64)]);
    expect((await db.query<any>('SELECT status,next_attempt_at<=now() due FROM veo_contact_demographics WHERE contact_id=$1', [client])).rows[0]).toEqual({ status: 'queued', due: true });
    expect((await db.query<any>('SELECT veo_profile_detail_access($1,$2) r', [manager, client])).rows[0].r.analysis.fields.some((f: any) => f.field === 'buying_purpose')).toBe(true);
    expect(await count()).toEqual(before);
    await expect(db.query('SELECT veo_profile_detail_request($1,$2,$3)', [owner, client, JSON.stringify([{ key: 'paid_amount', label: 'Paid amount' }])])).rejects.toThrow(/financial/);
});
it('blocks profile auto-fill access after Page revocation and keeps the new RPCs private', async () => {
    await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2', [manager, page]);
    try { await expect(db.query('SELECT veo_profile_detail_access($1,$2)', [manager, client])).rejects.toThrow(/denied/); }
    finally { await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [manager, page]); }
    expect((await db.query<any>("SELECT has_function_privilege('anon','veo_profile_detail_access(uuid,uuid)','EXECUTE') OR has_function_privilege('authenticated','veo_profile_detail_request(uuid,uuid,jsonb)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
});
