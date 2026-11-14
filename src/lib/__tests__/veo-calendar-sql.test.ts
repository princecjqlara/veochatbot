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
}, 180000);
afterAll(async () => { await db?.close(); });
it('prioritizes waiting customer lanes without letting a customer message overtake its earlier staff handoff',async()=>{
    await db.exec('BEGIN');try{
        await db.exec("UPDATE veo_event_inbox SET status='done'");
        const payload=(sender:string,recipient:string,mid:string,echo:boolean)=>JSON.stringify({object:'page',entry:[{id:'111',messaging:[{sender:{id:sender},recipient:{id:recipient},message:{mid,...(echo?{is_echo:true}:{})}}]}]});
        for(const[key,sender,recipient,echo,seconds]of [['unrelated','111','999',true,30],['handoff','111','555',true,20],['customer','555','111',false,10]] as const){
            await db.query("INSERT INTO veo_event_inbox(event_key,page_id,occurred_at,received_at,payload) VALUES($1,$2,now(),now()-$3::int*interval '1 second',$4)",['priority:'+key,page,seconds,payload(sender,recipient,key,echo)]);
        }
        const claim=async()=>{const row=(await db.query<any>('SELECT event_key FROM veo_claim_events(1)')).rows[0];await db.query("UPDATE veo_event_inbox SET status='done' WHERE event_key=$1",[row.event_key]);return row.event_key;};
        expect(await claim()).toBe('priority:handoff');expect(await claim()).toBe('priority:customer');expect(await claim()).toBe('priority:unrelated');
    }finally{await db.exec('ROLLBACK');}
});
it('registers real inbound clients atomically while their webhook is still queued and ignores echoes',async()=>{
    await db.exec('BEGIN');try{
        const psid='123456789',at=new Date(Date.now()-5000).toISOString();
        const event=(echo=false)=>({object:'page',entry:[{id:'111',messaging:[{sender:{id:echo?'111':psid},recipient:{id:echo?psid:'111'},message:{mid:echo?'own-echo':'real-inbound',...(echo?{is_echo:true}:{text:'Hello'})}}]}]});
        await db.query('SELECT veo_ingest_event($1,$2,$3,$4)',['111','auto-sync:inbound',at,JSON.stringify(event())]);
        const c=(await db.query<any>('SELECT id,last_inbound_at,first_interaction_at FROM contacts WHERE page_id=$1 AND psid=$2',[page,psid])).rows[0];
        expect(c).toBeTruthy();expect(new Date(c.last_inbound_at).toISOString()).toBe(at);
        expect((await db.query<any>("SELECT status FROM veo_event_inbox WHERE event_key='auto-sync:inbound'")).rows[0].status).toBe('queued');
        await db.query('SELECT veo_ingest_event($1,$2,$3,$4)',['111','auto-sync:echo',at,JSON.stringify(event(true))]);
        expect((await db.query('SELECT id FROM contacts WHERE page_id=$1 AND psid=$2',[page,'111'])).rows).toHaveLength(0);
        await db.query('SELECT veo_ingest_event($1,$2,$3,$4)',['111','auto-sync:inbound',at,JSON.stringify(event())]);
        expect((await db.query('SELECT id FROM contacts WHERE page_id=$1 AND psid=$2',[page,psid])).rows).toHaveLength(1);
        await db.query('DELETE FROM contacts WHERE id=$1',[c.id]);
        expect((await db.query<any>('SELECT veo_recover_queued_contact_identities(1000) n')).rows[0].n).toBeGreaterThan(0);
        expect((await db.query('SELECT id FROM contacts WHERE page_id=$1 AND psid=$2',[page,psid])).rows).toHaveLength(1);
    }finally{await db.exec('ROLLBACK');}
});
it('reconciles missing names without replacing existing names or inventing historical activity',async()=>{
    await db.exec('BEGIN');try{
        await db.query('INSERT INTO contacts(page_id,psid,name) VALUES($1,$2,NULL)',[page,'987654321']);
        const r=(await db.query<any>('SELECT veo_seed_contact_identities($1,$2,$3) r',[owner,page,JSON.stringify([{psid:'987654321',name:'Recovered name'},{psid:'987654322',name:'New identity'}])])).rows[0].r;
        expect(r.inserted).toBe(1);expect(r.updated_names).toBe(1);
        const rows=(await db.query<any>("SELECT name,first_interaction_at,last_inbound_at FROM contacts WHERE page_id=$1 AND psid IN('987654321','987654322')",[page])).rows;
        expect(rows).toHaveLength(2);expect(rows.every(c=>!c.first_interaction_at&&!c.last_inbound_at)).toBe(true);
        await db.query('SELECT veo_seed_contact_identities($1,$2,$3)',[owner,page,JSON.stringify([{psid:'987654321',name:'Different name'}])]);
        expect((await db.query<any>('SELECT name FROM contacts WHERE page_id=$1 AND psid=$2',[page,'987654321'])).rows[0].name).toBe('Recovered name');
    }finally{await db.exec('ROLLBACK');}
});
it('shares Page sync leases, fences checkpoints and exposes only scoped collection health',async()=>{
    await db.exec('BEGIN');try{
        const first=(await db.query<any>('SELECT veo_claim_contact_identity_pages(3) r')).rows[0].r;
        expect(first).toHaveLength(1);expect(first[0].page_id).toBe(page);
        expect((await db.query<any>('SELECT acquire_page_sync_lease($1,$2,60) ok',[page,'manual-sync'])).rows[0].ok).toBe(false);
        expect((await db.query<any>('SELECT veo_claim_contact_identity_pages(3) r')).rows[0].r).toEqual([]);
        expect((await db.query<any>('SELECT veo_finish_contact_identity_page($1,$2,$3,2,1,NULL) ok',[page,id(999),'bad-cursor'])).rows[0].ok).toBe(false);
        expect((await db.query<any>('SELECT veo_finish_contact_identity_page($1,$2,$3,2,1,NULL) ok',[page,first[0].lease_owner,'next-page'])).rows[0].ok).toBe(true);
        const health=(await db.query<any>('SELECT veo_collection_status($1) r',[owner])).rows[0].r;expect(health.map((p:any)=>p.page_id)).toEqual([page]);expect(JSON.stringify(health)).not.toContain('access_token');
        expect((await db.query<any>("SELECT has_function_privilege('authenticated','veo_claim_contact_identity_pages(integer)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
    }finally{await db.exec('ROLLBACK');}
});
it('enrolls recovered and newly enabled Pages without claiming historical message completeness',async()=>{
    await db.exec('BEGIN');try{
        const current=(await db.query<any>('SELECT capture_from FROM veo_calendar_message_coverage WHERE page_id=$1',[page])).rows[0];
        expect(current).toBeTruthy();expect(Date.parse(current.capture_from)).toBeGreaterThan(Date.now()-120000);
        await db.query("UPDATE pages SET name='Renamed Page' WHERE id=$1",[page]);
        expect((await db.query<any>('SELECT capture_from FROM veo_calendar_message_coverage WHERE page_id=$1',[page])).rows[0].capture_from).toStrictEqual(current.capture_from);
        await db.query('UPDATE pages SET veo_enabled=true,veo_tenant_id=(SELECT tenant_id FROM veo_accounts WHERE user_id=$1) WHERE id=$2',[owner,foreign]);
        expect((await db.query('SELECT 1 FROM veo_calendar_message_coverage WHERE page_id=$1',[foreign])).rows).toHaveLength(1);
        await db.query("UPDATE veo_calendar_message_coverage SET capture_from=now()-interval '3 days' WHERE page_id=$1",[foreign]);
        await db.query('UPDATE pages SET veo_enabled=false WHERE id=$1',[foreign]);await db.query('UPDATE pages SET veo_enabled=true WHERE id=$1',[foreign]);
        const restored=(await db.query<any>('SELECT capture_from FROM veo_calendar_message_coverage WHERE page_id=$1',[foreign])).rows[0];
        expect(Date.parse(restored.capture_from)).toBeGreaterThan(Date.now()-120000);
        expect((await db.query<any>("SELECT has_function_privilege('authenticated','veo_calendar_enroll_message_coverage()','EXECUTE') exposed")).rows[0].exposed).toBe(false);
    }finally{await db.exec('ROLLBACK');}
});
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
it('includes Qualified-lead verified payments in creative cohorts with stable payment identities and reconciled cost coverage',async()=>{
    await db.exec('BEGIN');try{
        await db.query("UPDATE contacts SET pipeline_stage='qualified' WHERE id=$1",[client]);
        await db.query("INSERT INTO ad_contact_sources(contact_id,page_id,first_inquiry_at,inquiry_basis,origin_ad_id,attribution_status) VALUES($1,$2,$3,'live_message','999','verified_inline') ON CONFLICT(contact_id) DO UPDATE SET origin_ad_id='999',attribution_status='verified_inline'",[client,page,`${earlier}T01:00:00+08:00`]);
        const report=(await db.query<any>('SELECT veo_creative_inputs($1,$2,$3,$4,$5) r',[owner,page,earlier,today,'999'])).rows[0].r;
        expect(report.cash).toHaveLength(2);expect(report.cash.reduce((n:number,p:any)=>n+Number(p.amount_minor),0)).toBe(203);
        expect(report.cash.every((p:any)=>p.payment_key.startsWith('workspace:')&&p.financial_source==='workspace')).toBe(true);
        expect(new Set(report.cash.map((p:any)=>p.payment_key)).size).toBe(2);expect(Array.isArray(report.reconciled_spend)).toBe(true);
        expect(report.orders[0].paid_minor).toBe(203);expect(JSON.stringify(report)).not.toContain('Suno');
    }finally{await db.exec('ROLLBACK');}
});
it('serializes ad refreshes by credential and keeps the lease private and token-bound',async()=>{
    await db.exec('BEGIN');try{
        await db.query("INSERT INTO meta_ads_credentials(user_id,token_ciphertext,token_iv,token_auth_tag,token_expires_at) VALUES($1,'test','test','test',now()+interval '1 hour')",[owner]);
        expect((await db.query<any>('SELECT veo_claim_meta_ads_refresh($1,$2) ok',[owner,id(800)])).rows[0].ok).toBe(true);
        expect((await db.query<any>('SELECT veo_claim_meta_ads_refresh($1,$2) ok',[owner,id(801)])).rows[0].ok).toBe(false);
        await db.query("UPDATE meta_ads_credentials SET refresh_lease_until=now()-interval '1 second' WHERE user_id=$1",[owner]);
        expect((await db.query<any>('SELECT veo_claim_meta_ads_refresh($1,$2) ok',[owner,id(801)])).rows[0].ok).toBe(true);
        expect((await db.query('UPDATE meta_ads_credentials SET refresh_lease_token=NULL WHERE user_id=$1 AND refresh_lease_token=$2 RETURNING user_id',[owner,id(800)])).rows).toHaveLength(0);
        expect((await db.query<any>("SELECT has_function_privilege('anon','veo_claim_meta_ads_refresh(uuid,uuid)','EXECUTE') OR has_function_privilege('authenticated','veo_claim_meta_ads_refresh(uuid,uuid)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
    }finally{await db.exec('ROLLBACK');}
});
it('limits repeated automatic cron calls to one start per hour across requests',async()=>{
 await db.exec('BEGIN');try{
  await db.query("INSERT INTO meta_ads_credentials(user_id,token_ciphertext,token_iv,token_auth_tag,token_expires_at) VALUES($1,'test','test','test',now()+interval '2 hours')",[owner]);
  const claim=async()=>(await db.query<any>('SELECT veo_claim_scheduled_meta_ads_refresh($1) ok',[owner])).rows[0].ok;
  expect(await claim()).toBe(true);expect(await claim()).toBe(false);
  const state=(await db.query<any>('SELECT * FROM meta_ads_credentials WHERE user_id=$1',[owner])).rows[0];expect(state.scheduled_refresh_status).toBe('running');expect(new Date(state.next_scheduled_refresh_at).getTime()-new Date(state.scheduled_refresh_started_at).getTime()).toBeGreaterThanOrEqual(3599990);
  await db.query("UPDATE meta_ads_credentials SET next_scheduled_refresh_at=now()-interval '1 second' WHERE user_id=$1",[owner]);expect(await claim()).toBe(true);
  expect((await db.query<any>("SELECT has_function_privilege('authenticated','veo_claim_scheduled_meta_ads_refresh(uuid)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
 }finally{await db.exec('ROLLBACK');}
});
it('defers automatic ads reads after a recent manual refresh, during a live lease, and after token expiry',async()=>{
 await db.exec('BEGIN');try{
  await db.query("INSERT INTO meta_ads_credentials(user_id,token_ciphertext,token_iv,token_auth_tag,token_expires_at,last_synced_at) VALUES($1,'test','test','test',now()+interval '2 hours',now())",[owner]);
  const claim=async()=>(await db.query<any>('SELECT veo_claim_scheduled_meta_ads_refresh($1) ok',[owner])).rows[0].ok;
  expect(await claim()).toBe(false);await db.query("UPDATE meta_ads_credentials SET last_synced_at=now()-interval '2 hours',refresh_lease_until=now()+interval '5 minutes' WHERE user_id=$1",[owner]);expect(await claim()).toBe(false);
  await db.query("UPDATE meta_ads_credentials SET refresh_lease_until=NULL,token_expires_at=now()-interval '1 second' WHERE user_id=$1",[owner]);expect(await claim()).toBe(false);
 }finally{await db.exec('ROLLBACK');}
});
it('requires the complete matching ad-cost window before deriving an ad-supported operating CPA',async()=>{
    await db.exec('BEGIN');try{
        await db.query("INSERT INTO veo_ad_planning_state VALUES($1,'93','PHP',1,10000,'daily',now(),'test')",[page]);
        await db.query(`INSERT INTO veo_ad_spend_coverage(page_id,spend_date,currency,amount_minor,ad_count,accounts_checked,checked_at,report_complete,pht_aligned)
          SELECT $1,d::date,'PHP',CASE WHEN d::date=$2::date THEN 1000 ELSE 0 END,CASE WHEN d::date=$2::date THEN 1 ELSE 0 END,1,now(),true,true
          FROM generate_series((SELECT(launch_at AT TIME ZONE 'Asia/Manila')::date FROM veo_tenants WHERE owner_id=$3),(veo_today()-1)::timestamp,interval '1 day') d`,[page,earlier,owner]);
        await db.query("INSERT INTO ad_daily_spend(page_id,ad_id,account_id,spend_date,currency,account_timezone,pht_aligned,amount,checked_at) VALUES($1,'91','93',$2,'PHP','Asia/Manila',true,10,now())",[page,earlier]);
        const read=async()=>(await db.query<any>('SELECT veo_supply_target($1,veo_today()+1,3) r',[manager])).rows[0].r;
        expect((await read()).pages[0].observed_cpa_minor).toBe(1000);
        await db.query("UPDATE ad_daily_spend SET checked_at=now()+interval '1 second' WHERE page_id=$1 AND ad_id='91'",[page]);
        const partial=await read();expect(partial.pages[0].observed_cpa_minor).toBeNull();expect(partial.supply_known).toBe(false);expect(partial.quota).toBe(3);
    }finally{await db.exec('ROLLBACK');}
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
    expect((await db.query<any>("SELECT indexdef FROM pg_indexes WHERE indexname='veo_event_profile_sources'")).rows[0].indexdef).toContain('page_id');
    expect((await db.query<any>("SELECT proconfig FROM pg_proc WHERE oid='veo_demographic_sources_base(uuid,uuid)'::regprocedure")).rows[0].proconfig).toContain('plan_cache_mode=force_custom_plan');
    expect((await db.query<any>("SELECT indexname FROM pg_indexes WHERE indexname IN('veo_calendar_contact_base','veo_calendar_meta_stages','veo_calendar_crm_stages')")).rows).toHaveLength(3);
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
it('exposes gross and refund components once and reports invoice creation independently of import time', async () => {
    const created: any = await action(manager, 'order', { request_id: id(70), seller_id: manager, page_id: page, contact_id: client, description: 'Earnings test', total_minor: 10000, currency: 'PHP' });
    await action(manager, 'payment', { request_id: id(71), order_id: created.id, kind: 'full', confirmed: true, reference: 'earnings-full', amount_minor: 10000, occurred_at: new Date(Date.now() - 2000).toISOString() });
    await action(manager, 'payment', { request_id: id(72), order_id: created.id, kind: 'refund', reason: 'Verified customer refund', confirmed: true, reference: 'earnings-refund', amount_minor: 1000, occurred_at: new Date(Date.now() - 1000).toISOString() });
    const components = (await db.query<any>('SELECT gross_before_refunds_minor,refunds_minor,paid_minor FROM veo_calendar_order_values WHERE id=$1', [created.id])).rows[0];
    expect(components).toMatchObject({ gross_before_refunds_minor: 10000, refunds_minor: 1000, paid_minor: 9000 });
    const invoice = { invoice_id: '999700', message_id: 'created-before-import', total_minor: 10000, currency: 'PHP', occurred_at: `${earlier}T12:00:00+08:00` };
    await db.query('SELECT veo_observe_business_orders($1,$2,$3::jsonb)', [owner, client, JSON.stringify([invoice])]);
    await db.query('UPDATE veo_business_orders SET order_id=$1 WHERE invoice_id=$2', [created.id, invoice.invoice_id]);
    const rows = (await db.query<any>('SELECT to_jsonb(x) r FROM veo_calendar_created_orders($1,$2,$3,$4) x', [owner, earlier, today, page])).rows.map(r => r.r);
    expect(rows.filter(r => r.order_key === `facebook:${page}:${invoice.invoice_id}`)).toHaveLength(1);
    expect(rows.find(r => r.order_key === `facebook:${page}:${invoice.invoice_id}`)?.created_date).toBe(earlier);
    expect(rows.some(r => r.order_key === `workspace:${created.id}`)).toBe(false);
    const details = (await db.query<any>('SELECT veo_calendar_day_details($1,$2,$3) r', [owner, earlier, page])).rows[0].r;
    expect(Array.isArray(details.selected_clients)).toBe(true); expect(Array.isArray(details.peer_lag_hours)).toBe(true);
    await expect(db.query('SELECT veo_calendar_day_details($1,$2,$3)', [manager, earlier, page])).rejects.toThrow(/denied/);
});
it('coordinates cron leases across owners, recovers expiry and keeps recovery functions private', async () => {
    const one = id(80), two = id(81);
    const claim = async (who: string) => (await db.query<any>("SELECT veo_claim_background_job('workspace',$1) ok", [who])).rows[0].ok;
    expect(await claim(one)).toBe(true); expect(await claim(two)).toBe(false);
    expect((await db.query<any>("SELECT veo_release_background_job('workspace',$1) ok", [two])).rows[0].ok).toBe(false);
    await db.exec("UPDATE veo_background_job_leases SET leased_until=now()-interval '1 second' WHERE job='workspace'");
    expect(await claim(two)).toBe(true);
    expect((await db.query<any>("SELECT veo_release_background_job('workspace',$1) ok", [one])).rows[0].ok).toBe(false);
    expect((await db.query<any>("SELECT has_function_privilege('anon','veo_claim_background_job(text,uuid)','EXECUTE') OR has_function_privilege('authenticated','veo_calendar_day_details(uuid,date,uuid)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
});
it('cleans only old completed payloads in bounded batches and keeps business records and duplicate keys', async () => {
    const before = (await db.query<any>('SELECT (SELECT count(*) FROM contacts)::int contacts,(SELECT count(*) FROM tags)::int tags,(SELECT count(*) FROM veo_orders)::int orders,(SELECT count(*) FROM veo_payments)::int payments')).rows[0];
    await db.query("INSERT INTO veo_event_inbox(event_key,page_id,occurred_at,received_at,status,payload) VALUES('storage:pending',$1,now()-interval '8 days',now()-interval '8 days','queued','{\"keep\":true}'),('storage:recent',$1,now(),now(),'done','{\"keep\":true}')", [page]);
    await db.query("INSERT INTO veo_event_inbox(event_key,page_id,occurred_at,received_at,status,payload) SELECT 'storage:old:'||i,$1,now()-interval '8 days',now()-interval '8 days','done','{\"discard\":true}' FROM generate_series(1,501) i", [page]);
    const result = (await db.query<any>('SELECT veo_storage_maintenance() r')).rows[0].r;expect(result.completed_event_payloads_cleared).toBe(500);
    const rows = (await db.query<any>("SELECT event_key,payload FROM veo_event_inbox WHERE event_key LIKE 'storage:%'")).rows;
    expect(rows).toHaveLength(503);expect(rows.filter(r => r.event_key.startsWith('storage:old:') && Object.keys(r.payload).length)).toHaveLength(1);
    expect(rows.find(r => r.event_key === 'storage:pending').payload.keep).toBe(true);expect(rows.find(r => r.event_key === 'storage:recent').payload.keep).toBe(true);
    expect((await db.query<any>('SELECT (SELECT count(*) FROM contacts)::int contacts,(SELECT count(*) FROM tags)::int tags,(SELECT count(*) FROM veo_orders)::int orders,(SELECT count(*) FROM veo_payments)::int payments')).rows[0]).toEqual(before);
    expect((await db.query<any>("SELECT count(*)::int n FROM cron.job WHERE jobname='veo-storage-protection'")).rows[0].n).toBe(1);
});
it('pauses historical growth for memory, swap or sustained load and resumes after a cooldown', async () => {
    await db.exec('BEGIN');try {
        await db.exec('SELECT veo_storage_maintenance()');
        const normal = { available: true, disk_size_bytes: 2000000000, disk_available_bytes: 1500000000, resource_metrics_available: true,
            memory_total_bytes: 400000000, memory_available_bytes: 100000000, swap_total_bytes: 1000000000, swap_free_bytes: 900000000, cpu_count: 2, load_5m: 0.5 };
        const record = async (extra: any = {}) => (await db.query<any>('SELECT veo_record_storage_metrics($1::jsonb) r', [JSON.stringify({ ...normal, ...extra })])).rows[0].r;
        expect(await record()).toMatchObject({ optional_work_paused: false, resource_metrics_fresh: true, resource_pressure: false });
        for (const [extra, reason] of [[{ memory_available_bytes: 20000000 }, 'low_memory'], [{ swap_free_bytes: 200000000 }, 'high_swap'], [{ load_5m: 3 }, 'sustained_load']] as const) {
            const pressured = await record(extra);
            expect(pressured).toMatchObject({ status: 'healthy', optional_work_paused: true, resource_pressure: true });
            expect(pressured.resource_pressure_reasons).toContain(reason);
        }
        expect(await record()).toMatchObject({ optional_work_paused: true, resource_pressure_reasons: ['recovery_cooldown'] });
        await db.exec("UPDATE app_private.veo_storage_state SET resource_paused_until=now()-interval '1 second'");
        expect(await record()).toMatchObject({ optional_work_paused: false, resource_pressure: false });
        await db.exec("UPDATE app_private.veo_storage_state SET resource_metrics_at=now()-interval '4 minutes'");
        expect((await db.query<any>('SELECT veo_storage_status() r')).rows[0].r).toMatchObject({ optional_work_paused: true, resource_metrics_fresh: false });
        await expect(record({ memory_available_bytes: 900000000 })).rejects.toThrow('Invalid resource metrics');
    } finally { await db.exec('ROLLBACK'); }
});
it('paginates scoped contacts with stable ties and preserves literal search matching', async () => {
    await db.exec('BEGIN');try {
        await db.query("INSERT INTO contacts(id,page_id,psid,name,last_interaction_at) VALUES($1,$4,'pressure-alpha','Pressure query alpha',now()),($2,$4,'pressure-beta','Pressure query beta',now()),($3,$5,'pressure-hidden','Pressure query hidden',now())", [id(950), id(951), id(952), page, foreign]);
        const list = async (offset = 0, search = 'Pressure query') => (await db.query<any>('SELECT veo_contacts_page($1,NULL,$2,$3,1) r', [owner, search, offset])).rows[0].r;
        const first = await list(), second = await list(1);
        expect(first.total).toBe(2);expect(first.items.map((x: any) => x.id)).toEqual([id(950)]);expect(second.items.map((x: any) => x.id)).toEqual([id(951)]);
        expect(first.items[0]).toMatchObject({ name: 'Pressure query alpha', psid: 'pressure-alpha', page_id: page, page_name: 'VEO' });
        expect((await list(0, 'pressure-alpha')).total).toBe(1);expect((await list(0, '%')).total).toBe(0);expect((await list(50)).items).toEqual([]);
        await expect(db.query('SELECT veo_contacts_page($1,$2)', [owner, foreign])).rejects.toThrow('Forbidden');
    } finally { await db.exec('ROLLBACK'); }
});
it('stops a client when an order is saved, preserving answers and cancelling every unsent job status', async () => {
    await db.exec('BEGIN');try {
        const cid = id(960);
        await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage,pipeline_stage_source) VALUES($1,$2,'ordered-client','Ordered client','qualified','chatbot')", [cid,page]);
        await db.query("INSERT INTO chatbot_contact_states(page_id,contact_id,collected_details,status) VALUES($1,$2,'{\"Business Name\":\"Saved answer\"}','active')", [page,cid]);
        await db.query("INSERT INTO chatbot_follow_up_jobs(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,due_at,message_text,status) SELECT $1,$2,now(),'response',n,now()+interval '1 hour','Queued reply',s FROM (VALUES(0,'pending'),(1,'processing'),(2,'waiting_response')) v(n,s)", [page,cid]);
        await db.query("INSERT INTO veo_orders(request_id,tenant_id,team_id,page_id,contact_id,seller_id,description,total_minor,currency,created_by) SELECT $1,tenant_id,id,$2,$3,$4,'Order',10000,'PHP',$5 FROM veo_teams WHERE manager_id=$4 LIMIT 1", [id(961),page,cid,manager,owner]);
        expect((await db.query<any>('SELECT chatbot_contact_sales_stop($1,$2) reason',[page,cid])).rows[0].reason).toBe('order_created');
        const state=(await db.query<any>('SELECT status,stop_reason,collected_details,automation_epoch FROM chatbot_contact_states WHERE contact_id=$1',[cid])).rows[0];
        expect(state).toMatchObject({status:'stopped',stop_reason:'order_created',collected_details:{'Business Name':'Saved answer'}});expect(state.automation_epoch).toBeGreaterThan(0);
        expect((await db.query<any>("SELECT count(*)::int n FROM chatbot_follow_up_jobs WHERE contact_id=$1 AND status='cancelled'",[cid])).rows[0].n).toBe(3);
        await expect(db.query('SELECT reset_chatbot_contact($1,$2)',[page,cid])).rejects.toThrow(/already has an order/);
    } finally { await db.exec('ROLLBACK'); }
});
it('switches only the selected contact off and on, invalidating work without inventing a human handoff', async () => {
    await db.exec('BEGIN');try {
        const cid=id(970);
        expect((await db.query<any>('SELECT veo_can_page($1,$2) allowed',[owner,page])).rows[0].allowed).toBe(true);
        await db.query("INSERT INTO contacts(id,page_id,psid,pipeline_stage,pipeline_stage_source) VALUES($1,$2,'off-client','engaged','chatbot')",[cid,page]);
        await db.query("INSERT INTO chatbot_contact_states(page_id,contact_id,status) VALUES($1,$2,'active')",[page,cid]);
        await db.query("INSERT INTO chatbot_follow_up_jobs(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,due_at,message_text) VALUES($1,$2,now(),'response',0,now()+interval '1 hour','Queued')",[page,cid]);
        const toggle=async(enabled:boolean)=>(await db.query<any>('SELECT set_contact_bot_permission($1,$2,$3,$4) r',[page,cid,owner,enabled])).rows[0].r;
        expect(await toggle(false)).toMatchObject({enabled:false,changed:true,cancelled_follow_ups:1});
        expect((await db.query<any>('SELECT chatbot_enabled FROM contacts WHERE id=$1',[cid])).rows[0].chatbot_enabled).toBe(false);
        expect(await toggle(true)).toMatchObject({enabled:true,changed:true});
        expect((await db.query<any>('SELECT status,automation_epoch FROM chatbot_contact_states WHERE contact_id=$1',[cid])).rows[0]).toMatchObject({status:'active'});
        expect((await db.query<any>("SELECT count(*)::int n FROM chatbot_follow_up_jobs WHERE contact_id=$1 AND status='cancelled'",[cid])).rows[0].n).toBe(1);
    } finally { await db.exec('ROLLBACK'); }
});
it('tracks physical disk pressure, stale monitoring and failed cleanup without exposing health functions publicly', async () => {
    const record = async (body: any) => (await db.query<any>('SELECT veo_record_storage_metrics($1::jsonb) r', [JSON.stringify({ resource_metrics_available: true, memory_total_bytes: 400000000, memory_available_bytes: 100000000, swap_total_bytes: 1000000000, swap_free_bytes: 900000000, cpu_count: 2, load_5m: 0.5, ...body })])).rows[0].r;
    const healthy = await record({ available: true, disk_size_bytes: 2000000000, disk_available_bytes: 1500000000, wal_bytes: 64000000 });
    expect(healthy).toMatchObject({ status: 'healthy', metrics_fresh: true, maintenance_healthy: true, optional_work_paused: false });
    expect(await record({ available: true, disk_size_bytes: 2000000000, disk_available_bytes: 500000000 })).toMatchObject({ status: 'warning', optional_work_paused: false });
    expect(await record({ available: true, disk_size_bytes: 2000000000, disk_available_bytes: 200000000 })).toMatchObject({ status: 'critical', optional_work_paused: true });
    expect(await record({ available: false })).toMatchObject({ status: 'critical', metrics_fresh: false, optional_work_paused: true });
    await record({ available: true, disk_size_bytes: 2000000000, disk_available_bytes: 1500000000 });
    await db.exec("UPDATE app_private.veo_storage_state SET metrics_ok_at=now()-interval '16 minutes'");
    expect((await db.query<any>('SELECT veo_storage_status() r')).rows[0].r).toMatchObject({ status: 'unknown', optional_work_paused: true });
    await expect(db.query('SELECT veo_owner_storage_health($1)', [manager])).rejects.toThrow(/Owner access/);
    expect((await db.query<any>("SELECT count(*)::int n FROM app_private.veo_storage_state")).rows[0].n).toBe(1);
    expect((await db.query<any>("SELECT has_function_privilege('anon','veo_storage_maintenance()','EXECUTE') OR has_function_privilege('authenticated','veo_owner_storage_health(uuid)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
});
