import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { schemaMigrationPlan } from '../../../scripts/lib/database-migration-safety.mjs';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = id(1), page = id(2), client = id(3), leader = id(4), manager = id(5), member = id(6), other = id(7);
let db: PGlite, tenant: string, receipt: string, order: string, transactionalTest = false;
const rpc = async (name: string, args: unknown[]) => {
    if (transactionalTest) await db.exec('SAVEPOINT rpc_check');
    try {
        const result = (await db.query<any>(`SELECT ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS r`, args)).rows[0].r;
        if (transactionalTest) await db.exec('RELEASE SAVEPOINT rpc_check');
        return result;
    } catch (e) { if (transactionalTest) await db.exec('ROLLBACK TO SAVEPOINT rpc_check; RELEASE SAVEPOINT rpc_check'); throw e; }
};
const action = (actor: string, kind: string, data: any) => rpc('veo_action', [actor, kind, JSON.stringify(data)]);
let request = 100;
async function upload(kind: string, orderId: string | null = null, hash = 'a'.repeat(64)) {
    const path = `${tenant}/${member}/${id(request++)}`;
    await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)', [path]);
    return rpc('veo_receipt_save', [member, JSON.stringify({ request_id: id(request++), seller_id: member, contact_id: client, receipt_kind: kind, order_id: orderId, object_path: path, photo_sha256: hash })]);
}
beforeAll(async () => {
    db = await PGlite.create({ extensions: { 'uuid-ossp': uuid_ossp, pg_trgm, vector } });
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA extensions;CREATE SCHEMA cron;
    CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text);CREATE TABLE cron.job_run_details(end_time timestamptz);
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS 'INSERT INTO cron.job(jobname) VALUES($1) RETURNING jobid';
    CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobid=$1 RETURNING true';`);
    // Build retained receipts with the previous workflow, then migrate those
    // records in the strict-gate suite below. This verifies upgrade compatibility.
    for (const m of schemaMigrationPlan().filter(m => m.name < '202611070021_')) await db.exec(m.sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;/g, '-- scheduler stub'));
    await db.query("INSERT INTO users(id,email,name) VALUES($1,'owner@example.com','CJ Lara')", [owner]);
    await db.query("INSERT INTO pages(id,fb_page_id,name,access_token) VALUES($1,'111','VEO','test')", [page]);
    await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [owner, page]);
    tenant = await rpc('veo_launch', [owner, [page]]);
    await db.query("UPDATE veo_tenants SET launch_at=now()-interval '7 days' WHERE id=$1", [tenant]);
    const account = (by: string, user: string, parent: string, role: string) => action(by, 'create_account', { user_id: user, parent_id: parent, role, name: role, email: user + '@example.com', password_hash: 'x'.repeat(40), page_ids: [page] });
    await account(owner, leader, owner, 'team_leader'); await account(leader, manager, leader, 'manager'); await account(manager, member, manager, 'member'); await account(owner, other, owner, 'manager');
    await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage) VALUES($1,$2,'client','Client','qualified')", [client, page]);
}, 60000);
afterAll(async () => { await db?.close(); });
it('stores incomplete receipt evidence as a hold without creating orders, payments or salary', async () => {
    await db.query("UPDATE contacts SET pipeline_stage='new' WHERE id=$1", [client]);
    const before = await rpc('veo_salary', [member, new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)]);
    const r = await upload('closed'); receipt = r.id;
    expect(r.salary_status).toBe('on_hold'); expect(r.salary_holds).toEqual(expect.arrayContaining(['eligible_lead_required', 'create_and_link_order']));
    expect(r.delivery_submission).toBeNull(); expect(r).not.toHaveProperty('object_path'); expect(r).not.toHaveProperty('photo_sha256');
    expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(0); expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(0);
    expect((await rpc('veo_salary', [member, before.work_date])).totals).toEqual(before.totals);
    expect((await upload('closed')).id).toBe(receipt);
});

it('shows holds to the worker and their supervisors, excluding another branch and revoked Pages', async () => {
    for (const actor of [member, manager, leader, owner]) expect((await rpc('veo_receipt_access', [actor, receipt])).id).toBe(receipt);
    await expect(rpc('veo_receipt_access', [other, receipt])).rejects.toThrow(/permitted/);
    await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2', [member, page]);
    await expect(rpc('veo_receipt_access', [member, receipt])).rejects.toThrow(/permitted/);
    await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [member, page]);
    expect((await db.query<any>("SELECT has_table_privilege('anon','veo_receipts','SELECT') OR has_function_privilege('authenticated','veo_receipt_recheck(uuid,uuid,uuid)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
});
it('requires an order, Qualified or Converted stage and verified settlement for Done; CD and DD evidence stay distinct', async () => {
    const made = await action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: client, total_minor: 10000, currency: 'PHP', description: 'Video' }); order = made.id;
    expect((await rpc('veo_receipt_recheck', [member, receipt, order])).salary_holds).toContain('verify_full_payment');
    await db.query("UPDATE contacts SET pipeline_stage='qualified' WHERE id=$1", [client]);
    await action(member, 'payment', { request_id: id(request++), order_id: order, kind: 'deposit', amount_minor: 4000, reference: 'FIRST-DEPOSIT', occurred_at: new Date().toISOString(), confirmed: true });
    const team = (await db.query<any>('SELECT team_id FROM veo_orders WHERE id=$1', [order])).rows[0].team_id;
    await db.query('UPDATE veo_teams SET telegram_chat_id=-100123 WHERE id=$1', [team]); await db.query('INSERT INTO veo_worker_mappings VALUES($1,12345)', [member]);
    const cd = await rpc('veo_receipt_recheck', [member, receipt, order]);
    expect(cd.holds).toEqual([]); expect(cd.salary_holds).toEqual(['verify_full_payment']); expect(cd.delivery_status).toBe('queued');
    expect((await rpc('veo_handoff', [cd.delivery_submission])).receipt_kind).toBe('closed');
    const dd = await upload('done', order, 'b'.repeat(64)); expect(dd.salary_status).toBe('on_hold'); expect(dd.delivery_submission).toBeNull();
    await action(member, 'payment', { request_id: id(request++), order_id: order, kind: 'balance', amount_minor: 6000, reference: 'FINAL-BALANCE', occurred_at: new Date().toISOString(), confirmed: true });
    const ready = await rpc('veo_receipt_recheck', [member, dd.id, order]); expect(ready.salary_status).toBe('counted_from_verified_ledger'); expect(ready.holds).toEqual([]);
    const handoff = await rpc('veo_handoff', [ready.delivery_submission]); expect(handoff.receipt_kind).toBe('done'); expect(handoff.paid_minor).toBe(10000);
    const salary = await rpc('veo_salary', [member, new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)]);
    expect(salary.closed).toBe(1); expect(salary.done).toBe(1); expect(salary.totals[0].gross_minor).toBe(10000);
    await rpc('veo_receipt_recheck', [member, dd.id, order]); expect((await db.query('SELECT * FROM veo_submissions')).rows).toHaveLength(2);
    await db.query("UPDATE contacts SET pipeline_stage='new' WHERE id=$1", [client]);
    expect(await rpc('veo_handoff', [ready.delivery_submission])).toBeNull(); expect((await rpc('veo_receipt_access', [member, dd.id])).salary_status).toBe('on_hold');
    expect((await rpc('veo_salary', [member, salary.work_date])).totals).toEqual([]);
    await db.query("UPDATE contacts SET pipeline_stage='converted' WHERE id=$1", [client]);
});
it('requires re-upload of expired evidence and never creates a duplicate sale on retries', async () => {
    const before = (await db.query('SELECT * FROM veo_payments')).rows.length;
    const r = await upload('done', order, 'c'.repeat(64));
    await db.query("UPDATE veo_photo_objects SET expires_at=now()-interval '1 minute' WHERE object_path=(SELECT object_path FROM veo_receipts WHERE id=$1)", [r.id]);
    expect((await rpc('veo_receipt_access', [owner, r.id])).holds).toContain('photo_expired_reupload');
    expect((await db.query('SELECT * FROM veo_payments')).rows).toHaveLength(before);
    expect((await db.query('SELECT * FROM veo_orders')).rows).toHaveLength(1);
});
it('reports salary holds in the seller branch and never invents missed poll votes from missing or stale data', async () => {
    const held = await upload('done', null, 'd'.repeat(64));
    const own = await rpc('veo_workflow_warnings', [member, null]);
    expect(own.workers).toHaveLength(1); expect(own.workers[0].warnings.some((w: any) => w.receipt_id === held.id)).toBe(true);
    expect(own.workers[0].warnings.some((w: any) => w.kind === 'availability_unanswered')).toBe(false);
    await expect(rpc('veo_workflow_warnings', [other, member])).rejects.toThrow(/denied/);
    await db.query("UPDATE veo_accounts SET enrolled_at=now()-interval '1 day' WHERE user_id=$1", [member]);
    const tomorrow = new Date(Date.now() + 32 * 3600000).toISOString().slice(0, 10);
    const person = { user_id: member, chat_id: -100123, telegram_user_id: 12345, membership: 'member', membership_confirmed: true, is_bot: false, observed_at: new Date().toISOString(), availability: { work_date: tomorrow, poll_id: 'actual-poll', created_at: new Date(Date.now() - 3 * 3600000).toISOString(), telegram_message_id: 99, has_vote: false, poll_url: 'https://t.me/c/123/99' } };
    await rpc('veo_apply_telegram_observations', [tenant, JSON.stringify({ tenant_id: tenant, workers: [person] })]);
    expect((await rpc('veo_workflow_warnings', [owner, member])).workers[0].warnings.some((w: any) => w.kind === 'availability_unanswered')).toBe(true);
    await db.query("UPDATE veo_telegram_staff_state SET observed_at=now()-interval '1 hour' WHERE user_id=$1", [member]);
    expect((await rpc('veo_workflow_warnings', [owner, member])).workers[0].warnings.some((w: any) => w.kind === 'availability_unanswered')).toBe(false);
    await rpc('veo_apply_telegram_observations', [tenant, JSON.stringify({ tenant_id: tenant, workers: [{ ...person, observed_at: new Date(Date.now() + 1).toISOString(), availability: { ...person.availability, has_vote: true }, attendance: { work_date: tomorrow, active: true, updated_at: new Date().toISOString() } }] })]);
    const cleared = (await rpc('veo_workflow_warnings', [member, null])).workers[0]; expect(cleared.active_tomorrow).toBe(true); expect(cleared.warnings.some((w: any) => w.kind === 'availability_unanswered')).toBe(false);
});
it('warns about overdue work without an explanation, excluding finished projects waiting for the client balance', async () => {
    const o = await action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: client, total_minor: 10000, currency: 'PHP', description: 'Older unfinished project' });
    await action(owner, 'payment', { request_id: id(request++), order_id: o.id, kind: 'deposit', amount_minor: 1000, reference: 'OLDER-DEPOSIT', occurred_at: new Date(Date.now() - 36 * 3600000).toISOString(), confirmed: true, reason: 'Verified fixture chronology' });
    expect((await rpc('veo_workflow_warnings', [member, null])).workers[0].warnings.some((w: any) => w.order_id === o.id && w.kind === 'overdue_without_reason')).toBe(true);
    await action(member, 'fulfillment', { order_id: o.id, status: 'working', reason: 'Customer requested another brief revision' });
    expect((await rpc('veo_workflow_warnings', [member, null])).workers[0].warnings.some((w: any) => w.order_id === o.id)).toBe(false);
    await action(member, 'fulfillment', { order_id: o.id, status: 'ready_waiting_payment', work_complete: true, reason: 'Finished project; client balance is pending' });
    expect((await db.query<any>('SELECT overdue FROM veo_work_facts WHERE id=$1', [o.id])).rows[0].overdue).toBe(false);
});
it('separates capacity from ads-supported operating quota, preserves existing client work and freezes snapshots', async () => {
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 32 * 3600000).toISOString().slice(0, 10);
    expect((await rpc('veo_supply_target', [member, today, 8])).ad_mode).toBe('unknown');
    await db.query("INSERT INTO veo_ad_planning_state VALUES($1,'99','PHP',0,0,'daily',now(),'Verified fixture inventory')", [page]);
    const none = await rpc('veo_supply_target', [member, today, 8]); expect(none).toMatchObject({ capacity: 8, quota: 1, ad_mode: 'no_ads', open_paid_clients: 1 });
    expect((await rpc('veo_supply_target', [other, today, 8])).quota).toBe(0);
    await db.query("INSERT INTO veo_ad_spend_coverage(page_id,spend_date,currency,amount_minor,ad_count,accounts_checked,checked_at,report_complete,pht_aligned) VALUES($1,veo_today()-1,'PHP',1000,1,1,now(),true,true)", [page]);
    await db.query("UPDATE veo_ad_planning_state SET active_ads=2,allocated_daily_budget_minor=40000 WHERE page_id=$1", [page]);
    expect((await rpc('veo_supply_target', [member, today, 8])).quota).toBe(8);
    const fixed = await rpc('veo_target', [member, tomorrow]);
    await db.query("UPDATE veo_ad_planning_state SET active_ads=0,allocated_daily_budget_minor=0 WHERE page_id=$1", [page]);
    expect(await rpc('veo_target', [member, tomorrow])).toBe(fixed);
    await db.query("UPDATE veo_ad_planning_state SET checked_at=now()-interval '4 hours' WHERE page_id=$1", [page]);
    expect((await rpc('veo_supply_target', [member, today, 8])).quota).toBe(8);
});
it('creative inputs enforce executive Page access and retain authoritative financial cohorts', async () => {
    const from = new Date(Date.now() - 6 * 86400000 + 8 * 3600000).toISOString().slice(0, 10), to = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    await expect(rpc('veo_creative_inputs', [member, page, from, to, null])).rejects.toThrow(/Owner/);
    await expect(rpc('veo_creative_inputs', [manager, page, from, to, null])).rejects.toThrow(/Owner/);
    const report = await rpc('veo_creative_inputs', [owner, page, from, to, null]);
    expect(Array.isArray(report.clients)).toBe(true); expect(Array.isArray(report.spend)).toBe(true); expect(report.page_id).toBe(page);
    expect((await db.query<any>("SELECT has_function_privilege('anon','veo_creative_inputs(uuid,uuid,date,date,text)','EXECUTE') AS exposed")).rows[0].exposed).toBe(false);
});
it('allocates Page quota toward supplied Pages while conserving each worker target', async () => {
    const otherPage = id(900);
    await db.query("INSERT INTO pages(id,fb_page_id,name,access_token,veo_tenant_id,veo_enabled) VALUES($1,'333','Funded Page','test',$2,true)", [otherPage, tenant]);
    for (const user of [owner, other]) await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [user, otherPage]);
    await db.query("UPDATE veo_ad_planning_state SET active_ads=0,allocated_daily_budget_minor=0,checked_at=now() WHERE page_id=$1", [page]);
    await db.query("INSERT INTO veo_ad_planning_state VALUES($1,'99','PHP',1,20000,'daily',now(),'Verified fixture inventory')", [otherPage]);
    expect(await rpc('veo_page_supply_weight', [other, page])).toBe(0); expect(await rpc('veo_page_supply_weight', [other, otherPage])).toBe(1);
    const plans = (await rpc('veo_page_capacity', [owner, new Date(Date.now() + 32 * 3600000).toISOString().slice(0, 10)])).plans;
    const allocations = plans.flatMap((p: any) => p.workers.filter((w: any) => w.user_id === other).map((w: any) => ({ page: p.page_id, target: w.page_target })));
    expect(allocations.find((a: any) => a.page === page).target).toBe(0); expect(allocations.find((a: any) => a.page === otherPage).target).toBe(1);
    expect(allocations.reduce((n: number, a: any) => n + a.target, 0)).toBe(1);
});
it('retains receipt notes, audits corrections and keeps notes separate from verified financial records', async () => {
    const path = `${tenant}/${member}/${id(request++)}`;
    await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)', [path]);
    const before = (await db.query<{ n: number }>('SELECT count(*)::int n FROM veo_payments')).rows[0].n;
    const saved = await rpc('veo_receipt_save', [member, JSON.stringify({ request_id: id(request++), seller_id: member, contact_id: client, receipt_kind: 'done', object_path: path, photo_sha256: 'f'.repeat(64), notes: 'Client asked to pay the balance tomorrow.' })]);
    expect(saved.notes).toBe('Client asked to pay the balance tomorrow.'); expect(saved.salary_status).toBe('on_hold');
    const updated = await rpc('veo_receipt_note', [manager, saved.id, 'Client confirmed the payment schedule.']);
    expect(updated.notes).toBe('Client confirmed the payment schedule.');
    expect((await db.query<any>("SELECT before_value,after_value FROM veo_audit WHERE action='receipt_notes' AND entity_id=$1", [saved.id])).rows[0]).toMatchObject({ before_value: { notes: saved.notes }, after_value: { notes: updated.notes } });
    await expect(rpc('veo_receipt_note', [other, saved.id, 'Unauthorized edit'])).rejects.toThrow(/permitted/);
    await expect(rpc('veo_receipt_note', [member, saved.id, 'a'.repeat(2001)])).rejects.toThrow(/2000/);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM veo_payments')).rows[0].n).toBe(before);
});
it('shows canonical commission only to the seller branch and prevents future quota freezing', async () => {
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 32 * 3600000).toISOString().slice(0, 10);
    const sold = await action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: client, total_minor: 10000, currency: 'PHP', description: 'Commission visibility fixture' });
    await action(member, 'payment', { request_id: id(request++), order_id: sold.id, kind: 'full', amount_minor: 10000, reference: 'VERIFIED-FULL', occurred_at: new Date().toISOString(), confirmed: true, confirm_converted: true });
    const canonical = await rpc('veo_salary', [member, day]);
    expect(canonical.totals.length).toBeGreaterThan(0);
    for (const actor of [member, manager, leader, owner]) expect(await rpc('veo_receipt_commission', [actor, member, day])).toMatchObject(canonical);
    await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2', [member, page]);
    const revoked = await rpc('veo_receipt_commission', [member, member, day]); expect(revoked.totals).toEqual([]); expect(revoked.rate).toBe(canonical.rate);
    await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [member, page]);
    await expect(rpc('veo_receipt_commission', [other, member, day])).rejects.toThrow(/branch/);
    await expect(rpc('veo_receipt_commission', [member, other, day])).rejects.toThrow(/branch/);
    await expect(rpc('veo_receipt_commission', [owner, member, tomorrow])).rejects.toThrow(/date/);
    await expect(rpc('veo_receipt_commission', [owner, member, '2020-01-01'])).rejects.toThrow(/date/);
    for (const fn of ['veo_receipt_note(uuid,uuid,text)', 'veo_receipt_commission(uuid,uuid,date)']) expect((await db.query<any>("SELECT has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') exposed", [fn])).rows[0].exposed).toBe(false);
});

async function stageClose(amount = 4000, currency = 'PHP', contactStage = 'qualified') {
    const cid = id(request++), path = `${tenant}/${member}/${id(request++)}`;
    await db.query('INSERT INTO contacts(id,page_id,psid,name,pipeline_stage) VALUES($1,$2,$4,\'Stage client\',$3)', [cid, page, contactStage, 'stage-' + cid]);
    await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)', [path]);
    const at = new Date(Date.now() - 36 * 3600000).toISOString();
    const receipt = await rpc('veo_receipt_save', [member, JSON.stringify({ request_id: id(request++), seller_id: member, contact_id: cid, receipt_kind: 'closed', object_path: path, photo_sha256: 'e'.repeat(64), closed_amount_minor: amount, closed_currency: currency, closed_occurred_at: at })]);
    return { cid, receipt, at };
}
it('counts a Qualified Closed Deal without creating an order or verified payment, and forwards a stable Closed Deal reference', async () => {
    const ordersBefore = (await db.query<{ n: number }>('SELECT count(*)::int n FROM veo_orders')).rows[0].n, paymentsBefore = (await db.query<{ n: number }>('SELECT count(*)::int n FROM veo_payments')).rows[0].n;
    const { cid, receipt } = await stageClose();
    expect(receipt.order_id).toBeNull(); expect(receipt.closed_deal_id).toBeTruthy(); expect(receipt.holds).toEqual([]); expect(receipt.salary_holds).toEqual(['create_and_link_order']);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM veo_orders')).rows[0].n).toBe(ordersBefore); expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM veo_payments')).rows[0].n).toBe(paymentsBefore);
    const fact = (await db.query<any>('SELECT * FROM veo_sales_facts WHERE contact_id=$1', [cid])).rows[0]; expect(fact.closed_date).toBeTruthy(); expect(fact.done_date).toBeNull(); expect(fact.paid_minor).toBe(0); expect(fact.order_created).toBe(false);
    const handoff = await rpc('veo_handoff', [receipt.delivery_submission]); expect(handoff.order_id).toBeNull(); expect(handoff.closed_deal_id).toBe(receipt.closed_deal_id); expect(handoff.payment_verified).toBe(false);
    const work = (await db.query<any>('SELECT overdue FROM veo_work_facts WHERE id=$1', [receipt.closed_deal_id])).rows[0]; expect(work.overdue).toBe(false);
});
it.each([-201, -200, -100, 0, 100, 200, 201])('reconciles the Closed Deal and final balance with a %i-cent price difference', async difference => {
    const { cid, receipt } = await stageClose();
    const o = await action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: cid, total_minor: 10000, currency: 'PHP', description: 'Stage deal', closed_deal_id: receipt.closed_deal_id });
    const payload = { request_id: id(request++), order_id: o.id, amount_minor: 6000 + difference, kind: 'balance', confirmed: true, settle_done: true, reference: 'FINAL-' + request, occurred_at: new Date().toISOString() };
    if (Math.abs(difference) > 200) {
        await expect(action(member, 'payment', payload)).rejects.toThrow(/maximum PHP 2/);
        expect((await db.query('SELECT * FROM veo_payments WHERE order_id=$1', [o.id])).rows).toHaveLength(0);
    } else {
        const saved = await action(member, 'payment', payload); expect(await action(member, 'payment', payload)).toEqual(saved);
        const payments = (await db.query<any>('SELECT * FROM veo_payments WHERE order_id=$1', [o.id])).rows; expect(payments).toHaveLength(2);
        expect(payments.reduce((n: number, p: any) => n + Number(p.amount_minor), 0)).toBe(10000 + difference);
        const facts = (await db.query<any>('SELECT * FROM veo_sales_facts WHERE contact_id=$1', [cid])).rows; expect(facts).toHaveLength(1); expect(facts[0].done_date).toBeTruthy(); expect(facts[0].closed_deal_id).toBe(receipt.closed_deal_id);
        const work = (await db.query<any>('SELECT balance_minor,waiting_payment FROM veo_work_facts WHERE id=$1', [o.id])).rows[0];expect(work.balance_minor).toBe(0);expect(work.waiting_payment).toBe(false);
        const cd = await rpc('veo_receipt_recheck', [member, receipt.id]); expect(cd.salary_status).toBe('counted_from_verified_ledger');
        const photo = `${tenant}/${member}/${id(request++)}`;await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)', [photo]);
        const dd = await rpc('veo_receipt_save', [member, JSON.stringify({ request_id: id(request++), seller_id: member, contact_id: cid, receipt_kind: 'done', order_id: o.id, closed_deal_id: receipt.closed_deal_id, object_path: photo, photo_sha256: 'd'.repeat(64) })]);
        expect(dd.done_balance_paid_minor).toBe(6000+difference);
        const handoff = await rpc('veo_handoff', [dd.delivery_submission]);expect(handoff.settlement_tolerance_minor).toBe(200);expect(handoff.paid_minor).toBe(10000 + difference);
    }
});
it('does not count an unqualified Closed Deal, rejects an uncreated Done order and requires exact non-PHP settlement', async () => {
    const pending = await stageClose(4000, 'USD', 'new');
    expect(pending.receipt.holds).toContain('eligible_lead_required'); expect((await db.query<any>('SELECT closed_date FROM veo_sales_facts WHERE contact_id=$1', [pending.cid])).rows[0].closed_date).toBeNull();
    await expect(action(member, 'payment', { order_id: pending.receipt.closed_deal_id, settle_done: true, confirmed: true, amount_minor: 6000, request_id: id(request++) })).rejects.toThrow(/Order outside/);
    await db.query("UPDATE contacts SET pipeline_stage='qualified' WHERE id=$1", [pending.cid]);
    const o = await action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: pending.cid, total_minor: 10000, currency: 'USD', description: 'Exact currency', closed_deal_id: pending.receipt.closed_deal_id });
    await expect(action(member, 'payment', { request_id: id(request++), order_id: o.id, settle_done: true, confirmed: true, kind: 'balance', amount_minor: 6001, reference: 'USD-OVER', occurred_at: new Date().toISOString() })).rejects.toThrow(/other currencies exact/);
});
it('re-uploading an expired Closed receipt after linking an order retains the same sale and delivery identity', async () => {
    const { cid, receipt, at } = await stageClose();
    const o = await action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: cid, total_minor: 10000, currency: 'PHP', description: 'Re-upload fixture', closed_deal_id: receipt.closed_deal_id });
    await db.query('UPDATE veo_photo_objects SET expires_at=now()-interval \'1 minute\' WHERE object_path=(SELECT object_path FROM veo_receipts WHERE id=$1)', [receipt.id]);
    const photo = `${tenant}/${member}/${id(request++)}`;await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)', [photo]);
    const fresh = await rpc('veo_receipt_save', [member, JSON.stringify({ request_id: id(request++), seller_id: member, contact_id: cid, receipt_kind: 'closed', closed_amount_minor: 4000, closed_currency: 'PHP', closed_occurred_at: at, object_path: photo, photo_sha256: 'e'.repeat(64) })]);
    expect(fresh.closed_deal_id).toBe(receipt.closed_deal_id);expect(fresh.order_id).toBe(o.id);expect(fresh.delivery_submission).not.toBe(receipt.delivery_submission);
    expect((await rpc('veo_handoff', [fresh.delivery_submission])).closed_deal_id).toBe(receipt.closed_deal_id);
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM veo_sales_facts WHERE contact_id=$1', [cid])).rows[0].n).toBe(1);
});
it('settles a fully covered Closed Deal without inventing an extra payment, and rejects a zero-payment Done Deal', async () => {
    const { cid, receipt } = await stageClose(10000);
    const o = await action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: cid, total_minor: 10000, currency: 'PHP', description: 'Covered by Closed receipt', closed_deal_id: receipt.closed_deal_id });
    const p = { request_id: id(request++), order_id: o.id, settle_done: true, confirmed: true, amount_minor: 0, reference: 'EXISTING-RECEIPT', occurred_at: new Date().toISOString() };
    await action(member, 'payment', p);await action(member, 'payment', p);
    expect((await db.query('SELECT * FROM veo_payments WHERE order_id=$1', [o.id])).rows).toHaveLength(1);
    const small = await action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: cid, total_minor: 100, currency: 'PHP', description: 'No fabricated free sale' });
    await expect(action(member, 'payment', { ...p, order_id: small.id, request_id: id(request++) })).rejects.toThrow(/actual verified payment/);
});
it('keeps a new client deal separate from earlier Closed Deals and imports a Facebook total idempotently',async()=>{
    const {cid,receipt}=await stageClose(4000);
    await rpc('veo_observe_business_orders',[member,cid,JSON.stringify([{invoice_id:String(request++),message_id:'meta-message',total_minor:10000,currency:'PHP',occurred_at:new Date().toISOString()}])]);
    const sources=await rpc('veo_business_orders_page',[member,cid]);expect(sources.items).toHaveLength(1);expect(sources.items[0]).not.toHaveProperty('message_id');
    const source=sources.items[0],payload={business_order_id:source.id,seller_id:member,deal_mode:'new',total_minor:1};
    const fresh=await action(member,'import_business_order',payload);expect(fresh.total_minor).toBe(10000);expect(fresh.deal_mode).toBe('new');expect((await action(member,'import_business_order',payload)).id).toBe(fresh.id);
    expect((await db.query<any>('SELECT order_id FROM veo_closed_deals WHERE id=$1',[receipt.closed_deal_id])).rows[0].order_id).toBeNull();
    await expect(action(other,'import_business_order',payload)).rejects.toThrow(/branch/);
    await expect(action(member,'payment',{request_id:id(request++),order_id:fresh.id,closed_deal_id:receipt.closed_deal_id,settle_done:true,confirmed:true,amount_minor:6000})).rejects.toThrow(/separate new deal/);
    await action(member,'payment',{request_id:id(request++),order_id:fresh.id,settle_done:true,confirmed:true,amount_minor:10000,occurred_at:new Date().toISOString(),reference:'NEW-SALE-'+request});
    expect((await db.query<any>('SELECT order_id FROM veo_closed_deals WHERE id=$1',[receipt.closed_deal_id])).rows[0].order_id).toBeNull();
    const secondInvoice=String(request++);await rpc('veo_observe_business_orders',[member,cid,JSON.stringify([{invoice_id:secondInvoice,message_id:'second-meta-message',total_minor:15000,currency:'PHP',occurred_at:new Date().toISOString()}])]);
    const second=(await rpc('veo_business_orders_page',[member,cid])).items.find((s:any)=>s.invoice_id===secondInvoice);
    const completed=await action(member,'import_business_order',{business_order_id:second.id,seller_id:member,deal_mode:'existing',closed_deal_id:receipt.closed_deal_id});
    expect((await db.query<any>('SELECT order_id FROM veo_closed_deals WHERE id=$1',[receipt.closed_deal_id])).rows[0].order_id).toBe(completed.id);
    expect((await db.query<any>('SELECT count(*)::int n FROM veo_sales_facts WHERE contact_id=$1',[cid])).rows[0].n).toBe(2);
});
it('requires current Facebook observations and blocks price changes, cross-client sources and revoked access',async()=>{
    const {cid}=await stageClose();const invoice=String(request++);
    const observed={invoice_id:invoice,message_id:'source-'+invoice,total_minor:10000,currency:'PHP',occurred_at:new Date().toISOString()};
    await rpc('veo_observe_business_orders',[member,cid,JSON.stringify([observed])]);const source=(await rpc('veo_business_orders_page',[member,cid])).items[0];
    await db.query("UPDATE veo_business_orders SET observed_at=now()-interval '16 minutes' WHERE id=$1",[source.id]);
    await expect(action(member,'import_business_order',{business_order_id:source.id,seller_id:member,deal_mode:'new'})).rejects.toThrow(/Fetch/);
    await rpc('veo_observe_business_orders',[member,cid,JSON.stringify([observed])]);const order=await action(member,'import_business_order',{business_order_id:source.id,seller_id:member,deal_mode:'new'});
    await rpc('veo_observe_business_orders',[member,cid,JSON.stringify([{...observed,total_minor:12000}])]);
    await expect(action(member,'payment',{request_id:id(request++),order_id:order.id,confirmed:true,amount_minor:10000,occurred_at:new Date().toISOString(),reference:'WRONG-PRICE',settle_done:true})).rejects.toThrow(/price changed/);
    await expect(rpc('veo_observe_business_orders',[member,client,JSON.stringify([observed])])).rejects.toThrow(/another client/);
    await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2',[member,page]);
    await expect(rpc('veo_business_orders_page',[member,cid])).rejects.toThrow(/access/);await expect(rpc('veo_observe_business_orders',[member,cid,JSON.stringify([observed])])).rejects.toThrow(/access/);
    await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)',[member,page]);
    for(const fn of ['veo_observe_business_orders(uuid,uuid,jsonb)','veo_business_orders_page(uuid,uuid)']) expect((await db.query<any>("SELECT has_function_privilege('anon',$1,'EXECUTE') exposed",[fn])).rows[0].exposed).toBe(false);
});
it('accepts multiple distinct new Closed Deals for the same client without replacing the earlier amount',async()=>{
    const {cid,receipt}=await stageClose(4000),path=`${tenant}/${member}/${id(request++)}`;await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)',[path]);
    const second=await rpc('veo_receipt_save',[member,JSON.stringify({request_id:id(request++),seller_id:member,contact_id:cid,receipt_kind:'closed',object_path:path,photo_sha256:'b'.repeat(64),closed_amount_minor:5000,closed_currency:'PHP',closed_occurred_at:new Date().toISOString(),deal_mode:'new'})]);
    expect(second.closed_deal_id).not.toBe(receipt.closed_deal_id);expect(second.closed_amount_minor).toBe(5000);expect((await rpc('veo_receipt_access',[member,receipt.id])).closed_amount_minor).toBe(4000);
});
it('lets staff delete their own receipt, stops forwarding and retains the sale and audit unless cancellation is chosen',async()=>{
    const {cid,receipt}=await stageClose(),before=(await db.query<{n:number}>('SELECT count(*)::int n FROM veo_payments')).rows[0].n;
    const deleted=await rpc('veo_receipt_delete',[member,receipt.id,'Uploaded the wrong photo',false]);
    expect(deleted.deleted_by).toBe(member);expect(deleted.salary_status).toBe('deleted');expect(deleted.photo_available).toBe(false);expect(deleted.holds).toEqual(['receipt_deleted']);
    expect(await rpc('veo_handoff',[receipt.delivery_submission])).toBeNull();
    expect((await db.query<any>('SELECT status FROM veo_submissions WHERE id=$1',[receipt.delivery_submission])).rows[0].status).toBe('blocked');
    expect((await db.query<any>('SELECT count(*)::int n FROM veo_sales_facts WHERE contact_id=$1',[cid])).rows[0].n).toBe(1);
    const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10),list=await rpc('veo_receipts_page',[owner,day,day,null,null,0]);expect(list.items.some((r:any)=>r.id===receipt.id)).toBe(false);
    const warnings=await rpc('veo_workflow_warnings',[member,null]);expect(warnings.workers[0].warnings.some((w:any)=>w.receipt_id===receipt.id)).toBe(false);
    await expect(rpc('veo_receipt_recheck',[member,receipt.id,null])).rejects.toThrow(/Deleted/);await expect(rpc('veo_receipt_note',[member,receipt.id,'Change'])).rejects.toThrow(/read-only/);
    await rpc('veo_receipt_delete',[member,receipt.id,'Retry of the same deletion',false]);
    expect((await db.query<any>("SELECT count(*)::int n FROM veo_audit WHERE entity_id=$1 AND action='receipt_deleted'",[receipt.id])).rows[0].n).toBe(1);
    expect((await db.query<{n:number}>('SELECT count(*)::int n FROM veo_payments')).rows[0].n).toBe(before);
});
it('allows managers, leaders and Owner to delete receipts in their branch while blocking other branches and revoked Pages',async()=>{
    for(const actor of [manager,leader,owner]){const {receipt}=await stageClose();expect((await rpc('veo_receipt_delete',[actor,receipt.id,'Duplicate evidence',false])).deleted_by).toBe(actor);}
    const {receipt}=await stageClose();await expect(rpc('veo_receipt_delete',[other,receipt.id,'Other branch',false])).rejects.toThrow(/permitted/);
    await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2',[manager,page]);await expect(rpc('veo_receipt_delete',[manager,receipt.id,'Revoked access',false])).rejects.toThrow(/permitted/);await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)',[manager,page]);
    await expect(rpc('veo_receipt_delete',[member,receipt.id,'',false])).rejects.toThrow(/reason/);
    expect((await db.query<any>("SELECT has_function_privilege('anon','veo_receipt_delete(uuid,uuid,text,boolean)','EXECUTE') OR has_function_privilege('authenticated','veo_receipt_delete(uuid,uuid,text,boolean)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
});
it('can explicitly cancel a mistaken order-free Closed Deal, and prevents it being linked or counted again',async()=>{
    const {cid,receipt,at}=await stageClose(),day=new Date(Date.parse(at)+8*3600000).toISOString().slice(0,10),before=await rpc('veo_salary',[member,day]);
    await rpc('veo_receipt_delete',[manager,receipt.id,'Wrong client selected; cancel this deal',true]);
    expect((await db.query<any>('SELECT count(*)::int n FROM veo_sales_facts WHERE contact_id=$1',[cid])).rows[0].n).toBe(0);expect((await rpc('veo_salary',[member,day])).closed).toBe(before.closed-1);
    const o=await action(member,'order',{request_id:id(request++),seller_id:member,page_id:page,contact_id:cid,total_minor:10000,currency:'PHP',description:'A different real deal',deal_mode:'new'});
    await expect(rpc('veo_link_closed_deal',[member,receipt.closed_deal_id,o.id])).rejects.toThrow(/same client/);
    expect((await db.query<any>('SELECT voided_by FROM veo_closed_deals WHERE id=$1',[receipt.closed_deal_id])).rows[0].voided_by).toBe(manager);
});
it('does not let receipt deletion cancel a linked deal or change verified payments and commission',async()=>{
    const {cid,receipt}=await stageClose(),o=await action(member,'order',{request_id:id(request++),seller_id:member,page_id:page,contact_id:cid,total_minor:10000,currency:'PHP',description:'Actual paid order',closed_deal_id:receipt.closed_deal_id});
    await action(member,'payment',{request_id:id(request++),order_id:o.id,settle_done:true,confirmed:true,amount_minor:6000,reference:'REAL-'+request,occurred_at:new Date().toISOString()});
    const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10),before=await rpc('veo_salary',[member,day]);
    await expect(rpc('veo_receipt_delete',[manager,receipt.id,'Cannot erase an actual sale',true])).rejects.toThrow(/unlinked/);
    await rpc('veo_receipt_delete',[member,receipt.id,'Remove incorrect evidence only',false]);expect(await rpc('veo_salary',[member,day])).toEqual(before);
    expect((await db.query('SELECT * FROM veo_payments WHERE order_id=$1',[o.id])).rows).toHaveLength(2);
});
it('lets another active receipt replace a never-sent deleted photo without reviving the deleted receipt',async()=>{
    const {cid,receipt}=await stageClose(),path=`${tenant}/${member}/${id(request++)}`;await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)',[path]);
    const alternative=await rpc('veo_receipt_save',[member,JSON.stringify({request_id:id(request++),contact_id:cid,seller_id:member,receipt_kind:'closed',closed_deal_id:receipt.closed_deal_id,object_path:path,photo_sha256:'a'.repeat(64)})]);
    expect(alternative.delivery_submission).toBe(receipt.delivery_submission);
    await rpc('veo_receipt_delete',[member,receipt.id,'Use clearer evidence',false]);await rpc('veo_receipt_recheck',[member,alternative.id,null]);
    expect((await rpc('veo_handoff',[alternative.delivery_submission])).closed_deal_id).toBe(receipt.closed_deal_id);
    await expect(rpc('veo_receipt_recheck',[member,receipt.id,null])).rejects.toThrow(/Deleted/);
});

describe('strict Facebook receipt submission after migrating retained records', () => {
    let cid: string, path: string, payload: any, invoice: string;
    const observe = (scan: any = {}) => rpc('veo_record_facebook_check', [member, cid, new Date().toISOString(), JSON.stringify({
        orders: [], stage: { stage: 'qualified', message_id: 'stage-' + cid, occurred_at: new Date(Date.now() - 60000).toISOString() }, complete: true, pages_checked: 1, coverage: 'Available notices checked', ...scan
    })]);
    const requirements = (kind = 'closed', oid: string | null = null) => rpc('veo_receipt_requirements', [member, cid, member, kind, oid, true]);
    const save = (extra: any = {}) => rpc('veo_receipt_save', [member, JSON.stringify({ ...payload, ...extra })]);
    async function facebookOrder(paid = false, difference = 0) {
        const notice = { invoice_id: invoice, message_id: 'order-' + cid, total_minor: 10000, currency: 'PHP', occurred_at: new Date(Date.now() - 30000).toISOString() };
        await observe({ orders: [notice] });
        const source = (await rpc('veo_business_orders_page', [member, cid])).items[0];
        const o = await action(member, 'import_business_order', { business_order_id: source.id, seller_id: member, deal_mode: 'new' });
        if (paid) await action(member, 'payment', { request_id: id(request++), order_id: o.id, kind: 'full', amount_minor: 10000 + difference, settle_done: true, confirmed: true, reference: 'BANK-' + cid, occurred_at: new Date(Date.now() - 5000).toISOString() });
        return { o, notice };
    }
    beforeAll(async () => {
        for (const migration of schemaMigrationPlan().filter(m => m.name >= '202611070021_')) await db.exec(migration.sql);
    });
    beforeEach(async () => {
        await db.exec('BEGIN'); transactionalTest = true;
        cid = id(request++); path = `${tenant}/${member}/${id(request++)}`; invoice = String(request++);
        await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage) VALUES($1,$2,$3,'Fresh client','qualified')", [cid, page, 'psid-' + cid]);
        await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)', [path]);
        await db.query('UPDATE veo_teams SET telegram_chat_id=-100123 WHERE manager_id=$1', [manager]);
        await db.query('INSERT INTO veo_worker_mappings(user_id,telegram_user_id) VALUES($1,12345) ON CONFLICT(user_id) DO UPDATE SET telegram_user_id=12345', [member]);
        payload = { request_id: id(request++), contact_id: cid, seller_id: member, receipt_kind: 'closed', deal_mode: 'new', object_path: path, photo_sha256: 'a'.repeat(64), closed_amount_minor: 4000, closed_currency: 'PHP', closed_occurred_at: new Date(Date.now() - 5000).toISOString() };
    });
    afterEach(async () => { transactionalTest = false; await db.exec('ROLLBACK'); });
    it('blocks direct RPC submission without Facebook evidence and creates no receipt, deal or queue', async () => {
        expect((await requirements()).blockers).toContain('facebook_check_required');
        await expect(save({ facebook: { stage: 'qualified' } })).rejects.toThrow(/not submitted/);
        for (const table of ['veo_receipts', 'veo_closed_deals', 'veo_orders']) expect((await db.query(`SELECT id FROM ${table} WHERE contact_id=$1`, [cid])).rows).toHaveLength(0);
    });
    it('rejects unavailable or partial Facebook stage evidence even when the local contact is Qualified', async () => {
        for (const scan of [{ stage: null }, { complete: false }, { error: 'Page connection expired', complete: false }]) {
            await observe(scan); expect((await requirements()).allowed).toBe(false); await expect(save()).rejects.toThrow(/not submitted/);
        }
    });
    it('checks the latest Facebook stage and preserves a newer manual correction in VEO', async () => {
        await observe({ stage: { stage: 'not_qualified', message_id: 'disqualified', occurred_at: new Date(Date.now() - 5000).toISOString() } });
        expect((await requirements()).blockers).toContain('facebook_eligible_lead_required');
        await db.query("UPDATE contacts SET pipeline_stage='new',pipeline_stage_source='manual',pipeline_stage_updated_at=clock_timestamp() WHERE id=$1", [cid]);
        await observe(); expect((await requirements()).blockers).toContain('eligible_lead_required');
    });
    it('restores a Qualified stage inferred incorrectly from an invoice notice, with an audit and exact source matching', async () => {
        const at = new Date(Date.now() - 30000).toISOString(), message = 'invoice-' + cid;
        await rpc('apply_messenger_lead_stage', [page, cid, message, 'Order Created', 'order_created', at]);
        const notice = { invoice_id: invoice, message_id: message, total_minor: 10000, currency: 'PHP', occurred_at: at };
        await observe({ orders: [notice] }); expect((await requirements()).allowed).toBe(true);
        expect((await db.query<any>('SELECT pipeline_stage FROM contacts WHERE id=$1', [cid])).rows[0].pipeline_stage).toBe('qualified');
        expect((await db.query("SELECT id FROM veo_audit WHERE entity_id=$1 AND action='facebook_explicit_stage_restored'", [cid])).rows).toHaveLength(1);
        await db.query("UPDATE contacts SET pipeline_stage='order_created',pipeline_stage_source='manual' WHERE id=$1", [cid]);
        await observe({ orders: [notice] }); expect((await requirements()).blockers).toContain('eligible_lead_required');
    });
    it('never replaces an explicit Order Created lead stage using an unrelated invoice notice', async () => {
        await rpc('apply_messenger_lead_stage', [page, cid, 'explicit-stage', 'Order Created', 'order_created', new Date(Date.now() - 30000).toISOString()]);
        await observe({ orders: [{ invoice_id: invoice, message_id: 'a-different-invoice', total_minor: 10000, currency: 'PHP', occurred_at: new Date(Date.now() - 30000).toISOString() }] });
        expect((await requirements()).blockers).toContain('eligible_lead_required');
    });
    it('does not let an older Facebook Qualified notice revive a more recent disqualification hidden behind an inferred invoice stage', async () => {
        await rpc('apply_messenger_lead_stage', [page, cid, 'newer-not-qualified', 'Not Qualified', 'not_qualified', new Date(Date.now() - 45000).toISOString()]);
        const at = new Date(Date.now() - 30000).toISOString(), message = 'invoice-' + cid;
        await rpc('apply_messenger_lead_stage', [page, cid, message, 'Order Created', 'order_created', at]);
        await observe({ orders: [{ invoice_id: invoice, message_id: message, total_minor: 10000, currency: 'PHP', occurred_at: at }] });
        expect((await requirements()).allowed).toBe(false);
        expect((await db.query<any>('SELECT pipeline_stage FROM contacts WHERE id=$1', [cid])).rows[0].pipeline_stage).not.toBe('qualified');
    });
    it('rejects stale Facebook stage evidence despite a local manual Qualified correction', async () => {
        await rpc('apply_messenger_lead_stage', [page, cid, 'newer-not-qualified', 'Not Qualified', 'not_qualified', new Date(Date.now() - 45000).toISOString()]);
        await db.query("UPDATE contacts SET pipeline_stage='qualified',pipeline_stage_source='manual',pipeline_stage_updated_at=clock_timestamp() WHERE id=$1", [cid]);
        await observe(); expect((await requirements()).allowed).toBe(false);
    });
    it('requires fresh evidence and cannot replace a newer failed observation with an older success', async () => {
        const older = new Date(Date.now() - 1000).toISOString(); await observe({ complete: false, error: 'Unavailable' });
        await rpc('veo_record_facebook_check', [member, cid, older, JSON.stringify({ orders: [], stage: { stage: 'qualified', message_id: 'older', occurred_at: older }, complete: true, pages_checked: 1 })]);
        expect((await requirements()).allowed).toBe(false);
        await observe(); await db.query("UPDATE veo_facebook_checks SET started_at=now()-interval '3 minutes' WHERE contact_id=$1", [cid]);
        expect((await requirements()).blockers).toContain('facebook_check_required'); await expect(save()).rejects.toThrow(/not submitted/);
    });
    it('accepts an eligible Closed Deal without an order and retains explicit salary prerequisites', async () => {
        await observe(); const r = await save();
        expect(r.holds).toEqual([]); expect(r.delivery_status).toBe('queued'); expect(r.closed_deal_id).toBeTruthy(); expect(r.order_id).toBeNull(); expect(r.salary_holds).toContain('create_and_link_order');
        expect(r.facebook_evidence.stage).toBe('qualified'); expect((await rpc('veo_handoff', [r.delivery_submission])).receipt_kind).toBe('closed');
        expect((await save()).duplicate).toBe(true); expect((await db.query('SELECT id FROM veo_closed_deals WHERE contact_id=$1', [cid])).rows).toHaveLength(1);
    });
    it('blocks Done without a matching Facebook order and blocks a matching but unpaid order', async () => {
        await observe(); expect((await requirements('done')).blockers).toContain('create_and_link_order');
        const { o } = await facebookOrder(); expect((await requirements('done', o.id)).blockers).toContain('verify_full_payment');
        await expect(save({ receipt_kind: 'done', order_id: o.id })).rejects.toThrow(/not submitted/);
        const local = await action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: cid, total_minor: 10000, currency: 'PHP', description: 'Local only', deal_mode: 'new' });
        expect((await requirements('done', local.id)).blockers).toContain('facebook_matching_order_required');
    });
    it.each([-200, 0, 200])('accepts verified Done with a %i-cent difference, queues once and retains immutable evidence', async difference => {
        const { o } = await facebookOrder(true, difference);
        expect((await requirements('done', o.id)).allowed).toBe(true);
        const r = await save({ receipt_kind: 'done', order_id: o.id });
        expect(r.holds).toEqual([]); expect(r.salary_holds).toEqual([]); expect((await save({ receipt_kind: 'done', order_id: o.id })).id).toBe(r.id);
        expect((await rpc('veo_handoff', [r.delivery_submission])).order_id).toBe(o.id);
        expect((await db.query('SELECT id FROM veo_receipts WHERE contact_id=$1', [cid])).rows).toHaveLength(1);
    });
    it('requires the matching invoice in the current check, and blocks changed Facebook prices', async () => {
        const { o, notice } = await facebookOrder(true); await observe();
        expect((await requirements('done', o.id)).blockers).toContain('facebook_matching_order_required');
        await observe({ orders: [{ ...notice, total_minor: 11000 }] });
        expect((await requirements('done', o.id)).blockers).toContain('facebook_matching_order_required');
    });
    it('turns an eligible Closed Deal into Done using its down payment and the amount actually sent, without duplicate CD counts', async () => {
        await observe(); const cd = await save();
        const notice = { invoice_id: invoice, message_id: 'order-' + cid, total_minor: 10000, currency: 'PHP', occurred_at: new Date(Date.now() - 30000).toISOString() };
        await observe({ orders: [notice] }); const source = (await rpc('veo_business_orders_page', [member, cid])).items[0];
        const o = await action(member, 'import_business_order', { business_order_id: source.id, seller_id: member, deal_mode: 'existing', closed_deal_id: cd.closed_deal_id });
        await action(member, 'payment', { request_id: id(request++), order_id: o.id, closed_deal_id: cd.closed_deal_id, amount_minor: 6000, settle_done: true, confirmed: true, reference: 'BALANCE-' + cid, occurred_at: new Date(Date.now() - 5000).toISOString() });
        const donePath = `${tenant}/${member}/${id(request++)}`; await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)', [donePath]);
        const dd = await save({ request_id: id(request++), receipt_kind: 'done', order_id: o.id, deal_mode: 'existing', closed_deal_id: cd.closed_deal_id, object_path: donePath, photo_sha256: 'b'.repeat(64) });
        expect(dd.holds).toEqual([]); expect(dd.paid_minor).toBe(10000); expect(dd.done_balance_paid_minor).toBe(6000);
        expect((await db.query('SELECT id FROM veo_sales_facts WHERE contact_id=$1', [cid])).rows).toHaveLength(1);
        expect((await db.query('SELECT id FROM veo_payments WHERE order_id=$1', [o.id])).rows).toHaveLength(2);
    });
    it.each([-201, 201])('rejects a %i-cent settlement difference before a Done receipt can be accepted', async difference => {
        await expect(facebookOrder(true, difference)).rejects.toThrow(/match|difference|price|exceed/i);
        expect((await db.query('SELECT id FROM veo_receipts WHERE contact_id=$1', [cid])).rows).toHaveLength(0);
    });
    it('blocks revoked Pages, other seller branches and missing Telegram mappings', async () => {
        await observe(); await expect(rpc('veo_receipt_requirements', [other, cid, member, 'closed', null, true])).rejects.toThrow(/branch/);
        await db.query('DELETE FROM veo_worker_mappings WHERE user_id=$1', [member]); expect((await requirements()).blockers).toContain('telegram_mapping_required');
        await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2', [member, page]);
        await expect(save()).rejects.toThrow(/access denied/);
    });
    it('rechecks Facebook before handoff, rejects stale or failed checks, and recovers without duplicate receipts', async () => {
        const { o, notice } = await facebookOrder(true), r = await save({ receipt_kind: 'done', order_id: o.id });
        await observe({ complete: false, error: 'Facebook unavailable' }); expect(await rpc('veo_handoff', [r.delivery_submission])).toBeNull();
        await expect(rpc('veo_receipt_recheck', [member, r.id, null])).rejects.toThrow(/ineligible/);
        await observe({ orders: [notice] }); expect((await rpc('veo_receipt_recheck', [member, r.id, null])).delivery_submission).toBe(r.delivery_submission);
        await db.query("UPDATE veo_facebook_checks SET started_at=now()-interval '3 minutes' WHERE contact_id=$1", [cid]); expect(await rpc('veo_handoff', [r.delivery_submission])).toBeNull();
        await observe({ orders: [notice] }); expect((await rpc('veo_handoff', [r.delivery_submission])).order_id).toBe(o.id);
        await action(manager, 'payment', { request_id: id(request++), order_id: o.id, kind: 'refund', amount_minor: 5000, confirmed: true, reason: 'Verified returned funds', reference: 'REFUND-' + cid, occurred_at: new Date(Date.now() - 5000).toISOString() });
        expect(await rpc('veo_handoff', [r.delivery_submission])).toBeNull();
    });
    it('keeps private evidence and all strict functions inaccessible to public roles and closes the old submission bypass', async () => {
        await expect(action(member, 'submission', { order_id: id(999), object_path: path })).rejects.toThrow(/Receipts/);
        expect((await db.query<any>("SELECT has_table_privilege('anon','veo_facebook_checks','SELECT') exposed")).rows[0].exposed).toBe(false);
        for (const fn of ['veo_record_facebook_check(uuid,uuid,timestamptz,jsonb)', 'veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean)', 'veo_submission_facebook_context(uuid)', 'veo_facebook_stage_conflicts(uuid)']) expect((await db.query<any>("SELECT has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') exposed", [fn])).rows[0].exposed).toBe(false);
    });
    it('hands Jaucian current scoped staff warnings and overdue explanations without leaking another worker warnings', async () => {
        const { o } = await facebookOrder();
        await action(member, 'payment', { request_id: id(request++), order_id: o.id, kind: 'deposit', amount_minor: 1000, confirmed: true, reference: 'DEPOSIT-' + cid, occurred_at: new Date(Date.now() - 36 * 3600000).toISOString() });
        const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 32 * 3600000).toISOString().slice(0, 10);
        await db.query("UPDATE veo_accounts SET enrolled_at=now()-interval '1 day' WHERE user_id=$1", [member]);
        await rpc('veo_apply_telegram_observations', [tenant, JSON.stringify({ tenant_id: tenant, workers: [{ user_id: member, chat_id: -100123, telegram_user_id: 12345, membership: 'member', membership_confirmed: true, is_bot: false, observed_at: new Date().toISOString(), availability: { work_date: tomorrow, poll_id: 'posted-poll', created_at: new Date(Date.now() - 3 * 3600000).toISOString(), has_vote: false, telegram_message_id: 99, poll_url: 'https://t.me/c/123/99' } }] })]);
        let report = await rpc('veo_operations_report', [tenant, today]);
        const worker = (data: any) => data.teams.flatMap((t: any) => t.workers).find((w: any) => w.id === member);
        expect(report.workflow_version).toBe(2); expect(report.warnings_as_of).toBeTruthy();
        expect(worker(report).warnings.map((w: any) => w.kind)).toEqual(expect.arrayContaining(['availability_unanswered', 'overdue_without_reason']));
        for (const w of report.teams.flatMap((t: any) => t.workers).filter((w: any) => w.id !== member)) expect(w.warnings.some((x: any) => x.key === `availability:${member}:${tomorrow}`)).toBe(false);
        await action(member, 'fulfillment', { order_id: o.id, status: 'working', reason: 'Client requested a revised script' });
        report = await rpc('veo_operations_report', [tenant, today]);
        expect(worker(report).clients.find((c: any) => c.order_id === o.id).work_reason).toBe('Client requested a revised script');
        expect(worker(report).warnings.some((w: any) => w.order_id === o.id && w.kind === 'overdue_without_reason')).toBe(false);
        expect((await db.query<any>("SELECT has_function_privilege('anon','veo_operations_report(uuid,date)','EXECUTE') exposed")).rows[0].exposed).toBe(false);
    });
    it('imports active tomorrow only from Jaucian votes, clears withdrawals, fences older replies and preserves today attendance', async () => {
        const days = (await db.query<any>('SELECT veo_today()::text today,(veo_today()+1)::text tomorrow')).rows[0];
        await db.query("UPDATE veo_accounts SET enrolled_at=now()-interval '1 day' WHERE user_id=$1", [member]);
        await db.query('DELETE FROM veo_telegram_staff_state WHERE user_id=$1', [member]);
        await db.query('DELETE FROM veo_attendance WHERE user_id=$1 AND work_date=$2', [member, days.tomorrow]);
        await db.query("INSERT INTO veo_attendance(user_id,work_date,active,updated_by,source) VALUES($1,$2,true,$3,'workspace') ON CONFLICT(user_id,work_date) DO UPDATE SET active=true,source='workspace'", [member, days.today, owner]);
        const base = Date.now() - 10000;
        const observation = (active: boolean | null, offset: number) => ({ tenant_id: tenant, workers: [{ user_id: member, chat_id: -100123, telegram_user_id: 12345, membership: 'member', membership_confirmed: true, is_bot: false, observed_at: new Date(base + offset).toISOString(), attendance: { work_date: days.tomorrow, active, updated_at: new Date(base + offset).toISOString() }, availability: { work_date: days.tomorrow, poll_id: 'registered-jaucian-poll', created_at: new Date(Date.now() - 3 * 3600000).toISOString(), has_vote: active !== null, telegram_message_id: 99, poll_url: 'https://t.me/c/123/99' } }] });
        expect((await rpc('veo_apply_telegram_observations', [tenant, JSON.stringify(observation(true, 0))])).attendance_imported).toBe(1);
        expect((await db.query<any>('SELECT active,source FROM veo_attendance WHERE user_id=$1 AND work_date=$2', [member, days.tomorrow])).rows[0]).toEqual({ active: true, source: 'telegram' });
        expect((await rpc('veo_workflow_warnings', [owner, member])).workers[0].active_tomorrow).toBe(true);
        await rpc('veo_apply_telegram_observations', [tenant, JSON.stringify(observation(null, 1000))]);
        await rpc('veo_apply_telegram_observations', [tenant, JSON.stringify(observation(true, 0))]);
        expect((await db.query('SELECT user_id FROM veo_attendance WHERE user_id=$1 AND work_date=$2', [member, days.tomorrow])).rows).toHaveLength(0);
        expect((await rpc('veo_workflow_warnings', [owner, member])).workers[0].active_tomorrow).toBeNull();
        expect((await db.query<any>('SELECT active,source FROM veo_attendance WHERE user_id=$1 AND work_date=$2', [member, days.today])).rows[0]).toEqual({ active: true, source: 'workspace' });
    });
});

describe('Tokko Ready/Busy and client acceptance', () => {
    const mate = id(80), foreign = id(81);
    let cid: string;
    const intake = (who: string, kind: string, extra: any = {}) => rpc('veo_intake_action', [who, kind, JSON.stringify({ request_id: id(request++), contact_id: cid, ...extra })]);
    const ready = (who: string) => intake(who, 'readiness', { status: 'ready' });
    const pageFor = (who: string, view = 'pool') => rpc('veo_intake_page', [who, view, null, cid, 0]);
    beforeAll(async () => {
        for (const [who, parentId] of [[mate, manager], [foreign, other]]) await action(owner, 'create_account', { user_id: who, parent_id: parentId, role: 'member', name: 'Intake worker ' + who, email: who + '@example.com', password_hash: 'x'.repeat(40), page_ids: [page] });
    });
    beforeEach(async () => {
        await db.exec('BEGIN'); transactionalTest = true;cid = id(request++);
        await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage,last_interaction_at) VALUES($1,$2,$3,'New intake client','new',clock_timestamp()-interval '1 second')", [cid, page, 'intake-' + cid]);
        await db.query('DELETE FROM veo_intake_readiness WHERE tenant_id=$1', [tenant]);
    });
    afterEach(async () => { transactionalTest = false;await db.exec('ROLLBACK'); });
    it('keeps the private queue current with contact edits, exclusions and deletion', async () => {
        expect((await db.query('SELECT id FROM veo_intake_contacts WHERE id=$1', [cid])).rows).toHaveLength(1);
        await db.query("UPDATE contacts SET name='Updated intake name',psid='updated-intake-psid',pipeline_stage='qualified' WHERE id=$1", [cid]);
        const changed = await rpc('veo_intake_page', [member, 'pool', null, 'Updated intake name', 0]);
        expect(changed.items[0]).toMatchObject({ id: cid, name: 'Updated intake name', psid: 'updated-intake-psid', pipeline_stage: 'qualified' });
        await db.query("UPDATE contacts SET pipeline_stage='not_qualified' WHERE id=$1", [cid]);expect((await pageFor(member)).items).toHaveLength(0);
        await db.query("UPDATE contacts SET last_interaction_at=now()-interval '20 days' WHERE id=$1", [cid]);
        expect((await db.query('SELECT id FROM veo_intake_contacts WHERE id=$1', [cid])).rows).toHaveLength(0);
        await db.query("UPDATE contacts SET pipeline_stage='qualified',last_interaction_at=now() WHERE id=$1", [cid]);expect((await pageFor(member)).total).toBe(1);
        await db.query('DELETE FROM contacts WHERE id=$1', [cid]);expect((await db.query('SELECT id FROM veo_intake_contacts WHERE id=$1', [cid])).rows).toHaveLength(0);
        expect((await db.query<any>("SELECT has_table_privilege('anon','veo_intake_contacts','SELECT') OR has_table_privilege('authenticated','veo_intake_contacts','SELECT') exposed")).rows[0].exposed).toBe(false);
    });
    it('searches and paginates queue clients before loading display details, including uppercase client IDs', async () => {
        await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage,last_interaction_at) SELECT gen_random_uuid(),$1,'intake-extra-'||i,'Queue row '||i,'new',now() FROM generate_series(1,52) i", [page]);
        const first = await rpc('veo_intake_page', [member, 'pool', null, 'Queue row', 0]);
        const second = await rpc('veo_intake_page', [member, 'pool', null, 'Queue row', 50]);
        expect(first.total).toBe(52);expect(first.items).toHaveLength(50);expect(second.items).toHaveLength(2);
        const all = [...first.items, ...second.items];expect(new Set(all.map((c: any) => c.id)).size).toBe(52);
        const exact = await rpc('veo_intake_page', [member, 'pool', page, first.items[0].id.toUpperCase(), 0]);
        expect(exact.total).toBe(1);expect(exact.items[0].id).toBe(first.items[0].id);expect(exact.items[0].page_name).toBeTruthy();
    });
    it('requires Ready, accepts once, makes the worker Busy and pauses the chatbot without a sale', async () => {
        await expect(intake(member, 'accept')).rejects.toThrow(/Ready/);
        await ready(member);expect((await pageFor(member)).readiness.ready).toBe(true);
        const req = id(request++), saved = await intake(member, 'accept', { request_id: req });expect(saved.user_id).toBe(member);
        expect((await intake(member, 'accept', { request_id: req })).duplicate).toBe(true);
        expect((await pageFor(member, 'assigned')).items[0].owner_id).toBe(member);expect((await pageFor(member)).readiness.ready).toBe(false);
        expect((await db.query<any>('SELECT chatbot_enabled FROM contacts WHERE id=$1', [cid])).rows[0].chatbot_enabled).toBe(false);
        expect((await db.query('SELECT id FROM veo_orders WHERE contact_id=$1', [cid])).rows).toHaveLength(0);
        expect((await db.query('SELECT id FROM veo_closed_deals WHERE contact_id=$1', [cid])).rows).toHaveLength(0);
        expect((await db.query('SELECT p.id FROM veo_payments p JOIN veo_orders o ON o.id=p.order_id WHERE o.contact_id=$1', [cid])).rows).toHaveLength(0);
    });
    it('reserves offers and prevents another branch or a second accept from taking them', async () => {
        await ready(member);await ready(foreign);const offer = await intake(manager, 'offer', { user_id: member });
        expect((await pageFor(foreign)).items).toHaveLength(0);
        await expect(intake(other, 'offer', { user_id: foreign })).rejects.toThrow(/branch|reserved/);
        await expect(intake(foreign, 'accept')).rejects.toThrow(/reserved|assigned/);
        await expect(intake(foreign, 'accept', { offer_id: offer.offer_id })).rejects.toThrow(/not assigned/);
        await intake(member, 'accept', { offer_id: offer.offer_id });await expect(intake(foreign, 'accept')).rejects.toThrow(/assigned/);
    });
    it('cancels incoming offers when Busy is selected and keeps tomorrow attendance unchanged', async () => {
        const before = (await db.query('SELECT * FROM veo_attendance WHERE user_id=$1 ORDER BY work_date', [member])).rows;
        await ready(member);const offer = await intake(owner, 'offer', { user_id: member });
        await intake(member, 'readiness', { status: 'busy' });
        expect((await pageFor(member, 'offers')).items).toHaveLength(0);
        await expect(intake(member, 'accept', { offer_id: offer.offer_id })).rejects.toThrow(/ended|expired/);
        expect((await db.query('SELECT * FROM veo_attendance WHERE user_id=$1 ORDER BY work_date', [member])).rows).toEqual(before);
    });
    it('allows a worker to offer their own unpaid new client to a Ready teammate and waits for acceptance', async () => {
        await ready(member);await intake(member, 'accept');await ready(mate);
        const offer = await intake(member, 'offer', { user_id: mate, reason: 'Teammate will handle the conversation' });
        expect((await pageFor(member, 'assigned')).items[0].owner_id).toBe(member);
        await intake(mate, 'accept', { offer_id: offer.offer_id });
        expect((await pageFor(member, 'assigned')).items).toHaveLength(0);expect((await pageFor(mate, 'assigned')).items[0].owner_id).toBe(mate);
        await expect(intake(member, 'offer', { user_id: foreign, reason: 'Outside our team' })).rejects.toThrow(/branch|authorized/);
    });
    it('requires a reassignment reason and current Ready, Page and supervisor access', async () => {
        await ready(member);await intake(member, 'accept');
        await expect(intake(manager, 'offer', { user_id: mate, reason: 'Handoff' })).rejects.toThrow(/Busy/);
        await ready(mate);await expect(intake(manager, 'offer', { user_id: mate })).rejects.toThrow(/reason/);
        const offer = await intake(manager, 'offer', { user_id: mate, reason: 'Supervisor reassignment' });
        await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2', [manager, page]);
        await expect(intake(mate, 'accept', { offer_id: offer.offer_id })).rejects.toThrow(/access|Page/);
    });
    it('expires Ready and offers and denies archived or opted-out contacts and the old assignment bypass', async () => {
        await expect(action(member, 'client_assignment', { contact_id: cid, user_id: member })).rejects.toThrow(/Ready/);
        await ready(member);const offer = await intake(owner, 'offer', { user_id: member });
        await db.query("UPDATE veo_intake_readiness SET expires_at=now()-interval '1 minute' WHERE user_id=$1", [member]);
        await expect(intake(member, 'accept', { offer_id: offer.offer_id })).rejects.toThrow(/Ready/);
        await ready(member);await db.query("UPDATE veo_client_offers SET expires_at=now()-interval '1 minute' WHERE id=$1", [offer.offer_id]);
        await expect(intake(member, 'accept', { offer_id: offer.offer_id })).rejects.toThrow(/expired/);
        await db.query("UPDATE contacts SET last_interaction_at=now()-interval '20 days' WHERE id=$1", [cid]);await expect(intake(member, 'accept')).rejects.toThrow(/queue/);
        await db.query("UPDATE contacts SET last_interaction_at=now(),pipeline_stage='opted_out' WHERE id=$1", [cid]);await expect(intake(member, 'accept')).rejects.toThrow(/queue/);
    });
    it('keeps existing order sellers and payments when a supervisor reassigns responsibility', async () => {
        await ready(member);await intake(member, 'accept');
        const o = await action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: cid, total_minor: 10000, currency: 'PHP', description: 'Existing sale', deal_mode: 'new' });
        await action(member, 'payment', { request_id: id(request++), order_id: o.id, kind: 'full', amount_minor: 10000, confirmed: true, reference: 'VERIFIED-' + cid, occurred_at: new Date(Date.now() - 5000).toISOString() });
        await ready(mate);await expect(intake(member, 'offer', { user_id: mate, reason: 'A paid client' })).rejects.toThrow(/authorized|branch/);
        const offer = await intake(manager, 'offer', { user_id: mate, reason: 'Reassign service only' });
        const before = (await db.query('SELECT * FROM veo_payments WHERE order_id=$1', [o.id])).rows;
        await intake(mate, 'accept', { offer_id: offer.offer_id });
        expect((await db.query<any>('SELECT seller_id FROM veo_orders WHERE id=$1', [o.id])).rows[0].seller_id).toBe(member);
        expect((await db.query('SELECT * FROM veo_payments WHERE order_id=$1', [o.id])).rows).toEqual(before);
        expect((await db.query<any>('SELECT assignee_id FROM veo_order_work WHERE order_id=$1', [o.id])).rows[0].assignee_id).toBe(mate);
    });
    it('scopes the roster and keeps all intake tables and functions private', async () => {
        const own = await pageFor(member), ids = own.roster.map((w: any) => w.id);
        expect(ids).toEqual(expect.arrayContaining([member, manager, mate]));expect(ids).not.toContain(other);expect(ids).not.toContain(foreign);
        await expect(intake(owner, 'readiness', { status: 'ready' })).rejects.toThrow(/Selling workers/);
        for (const fn of ['veo_intake_page(uuid,text,uuid,text,integer)', 'veo_intake_action(uuid,text,jsonb)', 'veo_intake_recipient(uuid,uuid,uuid)', 'veo_intake_can_offer(uuid,uuid,uuid)']) expect((await db.query<any>("SELECT has_function_privilege('anon',$1,'EXECUTE') OR has_function_privilege('authenticated',$1,'EXECUTE') exposed", [fn])).rows[0].exposed).toBe(false);
    });
    it('lets the original seller complete an existing Closed Deal after responsibility is handed over', async () => {
        await ready(member);await intake(member, 'accept');
        await rpc('veo_record_facebook_check', [member, cid, new Date().toISOString(), JSON.stringify({ orders: [], complete: true, pages_checked: 1, stage: { stage: 'qualified', message_id: 'stage-' + cid, occurred_at: new Date(Date.now() - 60000).toISOString() } })]);
        const path = `${tenant}/${member}/${id(request++)}`;await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)', [path]);
        const closed = await rpc('veo_receipt_save', [member, JSON.stringify({ request_id: id(request++), seller_id: member, contact_id: cid, receipt_kind: 'closed', deal_mode: 'new', object_path: path, photo_sha256: 'c'.repeat(64), closed_amount_minor: 4000, closed_currency: 'PHP', closed_occurred_at: new Date(Date.now() - 5000).toISOString() })]);
        await ready(mate);const offer = await intake(manager, 'offer', { user_id: mate, reason: 'Teammate handles the conversation' });await intake(mate, 'accept', { offer_id: offer.offer_id });
        await rpc('veo_observe_business_orders', [member, cid, JSON.stringify([{ invoice_id: String(request++), message_id: 'invoice-' + cid, total_minor: 10000, currency: 'PHP', occurred_at: new Date(Date.now() - 5000).toISOString() }])]);
        const source = (await rpc('veo_business_orders_page', [member, cid])).items[0];
        const o = await action(member, 'import_business_order', { business_order_id: source.id, seller_id: member, deal_mode: 'existing', closed_deal_id: closed.closed_deal_id });
        await action(member, 'payment', { request_id: id(request++), order_id: o.id, settle_done: true, amount_minor: 6000, confirmed: true, reference: 'BALANCE-' + cid, occurred_at: new Date(Date.now() - 5000).toISOString() });
        expect((await db.query<any>('SELECT seller_id,paid_minor FROM veo_order_facts WHERE id=$1', [o.id])).rows[0]).toEqual({ seller_id: member, paid_minor: 10000 });
        expect((await db.query<any>('SELECT assignee_id FROM veo_order_work WHERE order_id=$1', [o.id])).rows[0].assignee_id).toBe(mate);
        await expect(action(member, 'order', { request_id: id(request++), seller_id: member, page_id: page, contact_id: cid, total_minor: 10000, currency: 'PHP', description: 'Unrelated new sale', deal_mode: 'new' })).rejects.toThrow(/Claim|assigned/);
    });
});

describe('Telegram groups, Page routes and multiple memberships', () => {
    const secondPage = id(90), chatA = -100800, chatB = -100801, tgMember = 242424;
    let teamId: string;
    const groupAction = (actor: string, kind: string, data: any) => rpc('veo_telegram_group_action', [actor, kind, JSON.stringify(data)]);
    const link = (chat: number, pageIds: string[], extra: any = {}, actor = owner) => groupAction(actor, 'group', { team_id: teamId, chat_id: chat, page_ids: pageIds, ...extra });
    const bind = (user: string, chat: number, telegram = tgMember) => groupAction(owner, 'membership', { user_id: user, chat_id: chat, telegram_user_id: telegram });
    beforeEach(async () => {
        await db.exec('BEGIN');transactionalTest = true;
        teamId = (await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1', [manager])).rows[0].id;
        await db.query("INSERT INTO pages(id,fb_page_id,name,access_token,veo_tenant_id,veo_enabled) VALUES($1,'telegram-second-page','Second VEO Page','test',$2,true)", [secondPage, tenant]);
        for (const who of [owner, leader, manager, member]) await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [who, secondPage]);
        await rpc('veo_sync_telegram_groups', [owner, JSON.stringify([chatA, chatB].map((chat_id, i) => ({ chat_id, name: 'Group ' + i, topics: {}, pages: [page, secondPage].map(id => ({ id, name: id, matched: true })), identities: [] })))]);
        // This fixture uses the explicit new setup; retained primary mappings
        // remain supported separately until their supervisor migrates them.
        await db.query('UPDATE veo_teams SET telegram_chat_id=NULL WHERE id=$1', [teamId]);
    });
    afterEach(async () => { transactionalTest = false;await db.exec('ROLLBACK'); });
    async function twoGroups() { await link(chatA, [page]);await link(chatB, [secondPage]);await bind(member, chatA);await bind(member, chatB); }
    const observe = (chat: number, membership: string, offset: number, extra: any = {}) => rpc('veo_apply_telegram_observations', [tenant, JSON.stringify({ tenant_id: tenant, workers: [{ user_id: member, telegram_user_id: tgMember, chat_id: chat, membership, membership_confirmed: membership !== 'unknown', is_bot: false, observed_at: new Date(Date.now() + offset).toISOString(), ...extra }] })]);
    it('supports several Pages in one group and several groups for both members and selling managers', async () => {
        await link(chatA, [page, secondPage]);
        await expect(link(chatB, [secondPage])).rejects.toThrow(/Move Pages|another group/);
        await link(chatB, [secondPage], { move_pages: true, primary: true });
        for (const chat of [chatA, chatB]) { await bind(member, chat);await bind(manager, chat, 252525); }
        expect((await db.query('SELECT chat_id FROM veo_telegram_memberships WHERE user_id=$1', [manager])).rows).toHaveLength(2);
        expect((await rpc('veo_telegram_destination', [teamId, page, member])).chat_id).toBe(chatA);
        expect((await rpc('veo_telegram_destination', [teamId, secondPage, member])).chat_id).toBe(chatB);
        expect((await rpc('veo_telegram_groups_page', [manager])).links).toHaveLength(2);
        await groupAction(owner, 'remove_membership', { user_id: member, chat_id: chatA });
        expect(await rpc('veo_telegram_destination', [teamId, page, member])).toBeNull();
        expect((await rpc('veo_telegram_destination', [teamId, secondPage, member])).chat_id).toBe(chatB);
    });
    it('rejects cross-branch configuration, public grants and duplicate active Telegram identities', async () => {
        await expect(link(chatA, [page], {}, other)).rejects.toThrow(/branch/);
        await expect(link(chatA, [page], {}, member)).rejects.toThrow(/Supervisor/);
        await expect(rpc('veo_sync_telegram_groups', [manager, '[]'])).rejects.toThrow(/Head/);
        await link(chatA, [page]);await bind(member, chatA);
        await expect(bind(manager, chatA)).rejects.toThrow(/another active account/);
        const foreignView = await rpc('veo_telegram_groups_page', [other]);expect(foreignView.links).toHaveLength(0);expect(foreignView.memberships).toHaveLength(0);
        for (const table of ['veo_telegram_groups', 'veo_team_telegram_groups', 'veo_team_telegram_pages', 'veo_telegram_memberships', 'veo_telegram_group_states']) expect((await db.query<any>("SELECT has_table_privilege('anon',$1,'SELECT') OR has_table_privilege('authenticated',$1,'SELECT') exposed", [table])).rows[0].exposed).toBe(false);
    });
    it('rechecks Page revocation for routed delivery and keeps membership edits within the supervisor branch', async () => {
        await twoGroups();await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2', [manager, secondPage]);
        expect(await rpc('veo_telegram_destination', [teamId, secondPage, member])).toBeNull();
        expect((await rpc('veo_telegram_groups_page', [manager])).routes.every((r: any) => r.page_id !== secondPage)).toBe(true);
        await expect(groupAction(other, 'remove_membership', { user_id: member, chat_id: chatA })).rejects.toThrow(/branch/);
    });
    it('keeps staff employed after leaving one group or an unknown lookup and removes them only after all groups confirm departure', async () => {
        await twoGroups();expect((await observe(chatA, 'left', 100)).departures).toBe(0);
        expect((await observe(chatB, 'unknown', 200)).departures).toBe(0);
        expect((await observe(chatB, 'member', 300)).departures).toBe(0);
        expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1', [member])).rows[0].active).toBe(true);
        expect((await observe(chatB, 'kicked', 400)).departures).toBe(1);
        expect((await db.query<any>('SELECT active FROM veo_accounts WHERE user_id=$1', [member])).rows[0].active).toBe(false);
    });
    it('uses the latest linked-group tomorrow vote once, preserves withdrawals and never changes completed attendance', async () => {
        await twoGroups();const days = (await db.query<any>('SELECT veo_today()::text today,(veo_today()+1)::text tomorrow')).rows[0];
        await db.query("INSERT INTO veo_attendance(user_id,work_date,active,updated_by) VALUES($1,$2,true,$3) ON CONFLICT(user_id,work_date) DO UPDATE SET active=true", [member, days.today, owner]);
        const extra = (active: boolean | null, age: number) => ({ attendance: { work_date: days.tomorrow, active, updated_at: new Date(Date.now() + age).toISOString() } });
        await observe(chatA, 'member', 100, extra(false, -5000));await observe(chatB, 'member', 200, extra(true, -3000));
        expect((await db.query<any>('SELECT active FROM veo_attendance WHERE user_id=$1 AND work_date=$2', [member, days.tomorrow])).rows[0].active).toBe(true);
        await observe(chatB, 'member', 300, extra(null, -1000));
        expect((await db.query<any>('SELECT active FROM veo_attendance WHERE user_id=$1 AND work_date=$2', [member, days.tomorrow])).rows[0].active).toBe(false);
        await observe(chatA, 'member', 400, extra(null, 0));
        expect((await db.query('SELECT active FROM veo_attendance WHERE user_id=$1 AND work_date=$2', [member, days.tomorrow])).rows).toHaveLength(0);
        expect((await db.query<any>('SELECT active FROM veo_attendance WHERE user_id=$1 AND work_date=$2', [member, days.today])).rows[0].active).toBe(true);
    });
    it('uses Telegram Ready and bound Accept buttons to change the same Tokko client assignment exactly once', async () => {
        await twoGroups();const contactId = id(request++);
        await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage,last_interaction_at) VALUES($1,$2,$3,'Telegram candidate','new',now())", [contactId, page, contactId]);
        const receive = (kind: string, data: any = {}, uid = tgMember, chat = chatA) => rpc('veo_telegram_intake', [tenant, uid, chat, kind, JSON.stringify({ request_id: id(request++), ...data })]);
        const queued = await receive('pool');const rendered = await receive('render', { request_id: queued.request_id });
        const button = rendered.reply_markup.inline_keyboard.flat().find((b: any) => b.text === 'Accept · Telegram candidate');expect(button.callback_data.length).toBeLessThanOrEqual(64);
        const token = button.callback_data.slice(3);
        await expect(receive('callback', { token_id: token })).rejects.toThrow(/Ready/);
        await receive('ready');expect((await rpc('veo_intake_page', [member, 'pool', page, contactId, 0])).readiness.ready).toBe(true);
        await expect(receive('callback', { token_id: token }, tgMember, chatB)).rejects.toThrow(/another person|expired/);
        const saved = await receive('callback', { token_id: token });expect((await receive('callback', { token_id: token })).request_id).toBe(saved.request_id);
        expect((await db.query<any>('SELECT user_id FROM veo_client_claims WHERE contact_id=$1', [contactId])).rows[0].user_id).toBe(member);
        expect((await rpc('veo_intake_page', [member, 'assigned', page, contactId, 0])).readiness.ready).toBe(false);
        expect((await db.query('SELECT id FROM veo_orders WHERE contact_id=$1', [contactId])).rows).toHaveLength(0);
        expect((await db.query("SELECT id FROM veo_audit WHERE action='client_assignment' AND entity_id=$1", [contactId])).rows).toHaveLength(1);
    });
    it('creates a Telegram reassignment offer, renders it for its verified recipient and preserves ownership until acceptance', async () => {
        await twoGroups();await bind(manager, chatA, 252525);const contactId = id(request++);
        await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage,last_interaction_at) VALUES($1,$2,$3,'Handover candidate','new',now())", [contactId, page, contactId]);
        await rpc('veo_intake_action', [member, 'readiness', JSON.stringify({ request_id: id(request++), status: 'ready' })]);
        await rpc('veo_intake_action', [member, 'accept', JSON.stringify({ request_id: id(request++), contact_id: contactId })]);
        await rpc('veo_intake_action', [manager, 'readiness', JSON.stringify({ request_id: id(request++), status: 'ready' })]);
        const receive = (who: number, kind: string, data: any = {}) => rpc('veo_telegram_intake', [tenant, who, chatA, kind, JSON.stringify({ request_id: id(request++), ...data })]);
        const menu = await receive(tgMember, 'reassign'), listing = await receive(tgMember, 'render', { request_id: menu.request_id });
        const choose = listing.reply_markup.inline_keyboard.flat().find((b: any) => b.text === 'Offer / reassign');
        const choices = await receive(tgMember, 'callback', { token_id: choose.callback_data.slice(3) });
        const workers = await receive(tgMember, 'render', { request_id: choices.request_id });
        const pick = workers.reply_markup.inline_keyboard.flat().find((b: any) => b.text.startsWith('Offer to '));
        await receive(tgMember, 'callback', { token_id: pick.callback_data.slice(3) });
        expect((await db.query<any>('SELECT user_id FROM veo_client_claims WHERE contact_id=$1', [contactId])).rows[0].user_id).toBe(member);
        const pending = (await rpc('veo_telegram_intake_pending', [tenant])).find((o: any) => o.telegram_user_id === 252525);
        expect(pending.chat_id).toBe(chatA);
        const offer = await receive(252525, 'render_offer', { offer_id: pending.offer_id });
        const accept = offer.reply_markup.inline_keyboard.flat().find((b: any) => b.text.startsWith('Accept ·'));
        await receive(252525, 'callback', { token_id: accept.callback_data.slice(3) });
        expect((await db.query<any>('SELECT user_id FROM veo_client_claims WHERE contact_id=$1', [contactId])).rows[0].user_id).toBe(manager);
        await expect(receive(tgMember, 'render_offer', { offer_id: pending.offer_id })).rejects.toThrow(/offer expired|ended|access changed/);
    });
    it('blocks forged identities, expired assignment buttons and queued replies after Page revocation', async () => {
        await twoGroups();const receive = (kind: string, data: any = {}, tg = tgMember) => rpc('veo_telegram_intake', [tenant, tg, chatA, kind, JSON.stringify({ request_id: id(request++), ...data })]);
        await expect(receive('ready', {}, 999999)).rejects.toThrow(/verify your Telegram/);
        const command = await receive('pool'), rendered = await receive('render', { request_id: command.request_id });
        const button = rendered.reply_markup.inline_keyboard.flat().find((b: any) => b.text === 'Ready');
        await db.query("UPDATE veo_telegram_intake_tokens SET expires_at=now()-interval '1 minute' WHERE id=$1", [button.callback_data.slice(3)]);
        await expect(receive('callback', { token_id: button.callback_data.slice(3) })).rejects.toThrow(/expired/);
        await db.query('DELETE FROM user_pages WHERE user_id=$1 AND page_id=$2', [member, page]);
        await expect(receive('render', { request_id: command.request_id })).rejects.toThrow(/Page access|permitted Pages/);
    });
    it('routes receipt handoff and group reports by Page, blocking delivery when that group membership is missing', async () => {
        await link(chatA, [page]);await link(chatB, [secondPage]);await bind(member, chatA);
        const contactId = id(request++), path = `${tenant}/${member}/${id(request++)}`;
        await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage,last_interaction_at) VALUES($1,$2,$3,'Second group receipt','qualified',now())", [contactId, secondPage, contactId]);
        await rpc('veo_record_facebook_check', [member, contactId, new Date().toISOString(), JSON.stringify({ orders: [], complete: true, pages_checked: 1, stage: { stage: 'qualified', message_id: 'stage-' + contactId, occurred_at: new Date(Date.now() - 60000).toISOString() } })]);
        await db.query('INSERT INTO veo_photo_objects(object_path) VALUES($1)', [path]);
        expect((await rpc('veo_receipt_requirements', [member, contactId, member, 'closed', null, true])).blockers).toContain('telegram_page_or_membership_required');
        await bind(member, chatB);
        const r = await rpc('veo_receipt_save', [member, JSON.stringify({ request_id: id(request++), seller_id: member, contact_id: contactId, receipt_kind: 'closed', deal_mode: 'new', object_path: path, photo_sha256: '8'.repeat(64), closed_amount_minor: 1000, closed_currency: 'PHP', closed_occurred_at: new Date(Date.now() - 5000).toISOString() })]);
        const rechecked = await rpc('veo_receipt_recheck', [member, r.id, null]);
        expect((await rpc('veo_handoff', [rechecked.delivery_submission])).telegram_chat_id).toBe(chatB);
        const today = (await db.query<any>('SELECT veo_today()::text AS work_day')).rows[0].work_day;
        const report = await rpc('veo_operations_report', [tenant, today]);
        const a = report.teams.find((t: any) => t.id === teamId && t.chat_id === chatA), b = report.teams.find((t: any) => t.id === teamId && t.chat_id === chatB);
        expect(a.group_page_ids).toEqual([page]);expect(b.group_page_ids).toEqual([secondPage]);expect(a.delivery_key).not.toBe(b.delivery_key);
        expect(JSON.stringify(a)).not.toContain('Second group receipt');expect(JSON.stringify(b)).toContain('Second group receipt');expect(b.capacity.closed).toBeGreaterThanOrEqual(1);
        await groupAction(owner, 'remove_membership', { user_id: member, chat_id: chatB });
        expect(await rpc('veo_handoff', [rechecked.delivery_submission])).toBeNull();
        expect((await db.query('SELECT id FROM veo_orders WHERE contact_id=$1', [contactId])).rows).toHaveLength(0);
    });
    it('does not turn stale membership from one group into a fresh missed-vote warning when another group leaves', async () => {
        await twoGroups();await db.query("UPDATE veo_accounts SET enrolled_at=now()-interval '1 day' WHERE user_id=$1", [member]);
        const tomorrow = (await db.query<any>('SELECT (veo_today()+1)::text AS work_day')).rows[0].work_day;
        await observe(chatA, 'member', 100, { availability: { work_date: tomorrow, poll_id: 'group-a-poll', has_vote: false, created_at: new Date(Date.now() - 10800000).toISOString() } });
        await db.query("UPDATE veo_telegram_group_states SET observed_at=now()-interval '1 hour' WHERE user_id=$1 AND chat_id=$2", [member, chatA]);
        await observe(chatB, 'left', 200);
        expect((await rpc('veo_workflow_warnings', [owner, member])).workers[0].warnings.some((w: any) => w.kind === 'availability_unanswered')).toBe(false);
    });
});


describe('automatic Telegram teams and direct leader members', () => {
    const direct = id(920), newPage = id(921), chatA = -100920, chatB = -100921, tg = 909090;
    const payload = (user: string, telegram: number, chat: number, membership = 'member', extra: any = {}) => ({ user_id: user, telegram_user_id: telegram, chat_id: chat, membership, membership_confirmed: true, is_bot: false, observed_at: new Date().toISOString(), ...extra });
    const automate = (workers: any[]) => rpc('veo_apply_telegram_automation', [tenant, JSON.stringify({ tenant_id: tenant, workers, next_offset: 0 })]);
    const account = (user: string, role = 'member', parent = leader, pages: string[] = []) => action(leader, 'create_account', { user_id: user, parent_id: parent, role, name: 'Direct member', email: user + '@example.com', password_hash: 'x'.repeat(40), page_ids: pages });
    beforeEach(async () => {
        await db.exec('BEGIN'); transactionalTest = true;
        await db.query("INSERT INTO pages(id,fb_page_id,name,access_token,veo_tenant_id,veo_enabled) VALUES($1,'auto-page','Automatic Page','test',$2,true)", [newPage, tenant]);
        for (const who of [owner, leader]) await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [who, newPage]);
        await rpc('veo_sync_telegram_groups', [owner, JSON.stringify([chatA, chatB].map(chat_id => ({ chat_id, name: 'Auto group', topics: {}, pages: [{ id: newPage, matched: true }], identities: [] })))]);
        await account(direct);
        await db.query('INSERT INTO veo_worker_mappings VALUES($1,$2),($3,$4)', [direct, tg, leader, tg + 1]);
    });
    afterEach(async () => { transactionalTest = false; await db.exec('ROLLBACK'); });
    it('creates members without a manager or initial Pages, while retaining branch isolation and existing manager teams', async () => {
        expect((await db.query<any>('SELECT parent_id FROM veo_accounts WHERE user_id=$1', [direct])).rows[0].parent_id).toBe(leader);
        expect((await db.query<any>('SELECT manager_id FROM veo_teams WHERE manager_id=$1', [leader])).rows).toHaveLength(1);
        await expect(account(id(922), 'member', other)).rejects.toThrow(/hierarchy/);
        await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [direct, page]);
        const capacity = await rpc('veo_team_capacity', [owner]);
        const directTeam = capacity.teams.find((t: any) => t.manager_id === leader);
        expect(directTeam.workers).toBe(1);
        expect(capacity.teams.find((t: any) => t.manager_id === manager).workers).toBe(3);
    });
    it('discovers an admin leader group and grants its Pages to verified direct members without changing roles', async () => {
        await automate([payload(direct, tg, chatA), payload(leader, tg + 1, chatA, 'administrator')]);
        expect(await rpc('veo_can_page', [direct, newPage])).toBe(true);
        const setup = await rpc('veo_telegram_groups_page', [owner]);
        const team = setup.teams.find((t: any) => t.manager_id === leader);
        expect(setup.routes).toContainEqual(expect.objectContaining({ team_id: team.id, page_id: newPage, chat_id: chatA }));
        expect(setup.memberships).toContainEqual(expect.objectContaining({ user_id: direct, chat_id: chatA }));
        expect((await db.query<any>('SELECT role FROM veo_accounts WHERE user_id=$1', [direct])).rows[0].role).toBe('member');
        await rpc('veo_intake_action', [direct, 'readiness', JSON.stringify({ request_id: id(request++), status: 'ready' })]);
    });
    it('lets a Telegram group report directly to its leader, who can offer clients to direct members without a manager', async () => {
        const head = id(940), worker = id(941), customer = id(942), headTg = tg + 20, workerTg = tg + 21;
        await action(owner, 'create_account', { user_id: head, parent_id: owner, role: 'team_leader', name: 'Telegram Leader', email: head + '@example.com', password_hash: 'x'.repeat(40), page_ids: [newPage] });
        await action(head, 'create_account', { user_id: worker, parent_id: head, role: 'member', name: 'Direct Telegram Worker', email: worker + '@example.com', password_hash: 'x'.repeat(40), page_ids: [] });
        const team = (await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1', [head])).rows[0].id;
        expect((await db.query("SELECT user_id FROM veo_accounts WHERE parent_id=$1 AND role='manager'", [head])).rows).toHaveLength(0);
        await rpc('veo_telegram_group_action', [head, 'group', JSON.stringify({ team_id: team, chat_id: chatA, page_ids: [newPage] })]);
        await db.query('INSERT INTO veo_worker_mappings VALUES($1,$2),($3,$4)', [head, headTg, worker, workerTg]);
        await automate([payload(head, headTg, chatA, 'administrator'), payload(worker, workerTg, chatA)]);
        expect((await rpc('veo_telegram_intake_context', [tenant, headTg, chatA])).role).toBe('team_leader');
        expect((await rpc('veo_telegram_intake_context', [tenant, workerTg, chatA])).actor_id).toBe(worker);
        const receive = (who: number, kind: string, data: any = {}) => rpc('veo_telegram_intake', [tenant, who, chatA, kind, JSON.stringify({ request_id: id(request++), ...data })]);
        await receive(workerTg, 'ready');
        await db.query("INSERT INTO contacts(id,page_id,psid,name,pipeline_stage,last_interaction_at) VALUES($1,$2,$3,'Direct leader client','new',now())", [customer, newPage, customer]);
        const menu = await receive(headTg, 'pool');
        const rendered = await receive(headTg, 'render', { request_id: menu.request_id });
        const choose = rendered.reply_markup.inline_keyboard.flat().find((b: any) => b.text === 'Offer / reassign');
        expect(choose).toBeTruthy();
        const selection = await receive(headTg, 'callback', { token_id: choose.callback_data.slice(3) });
        const choices = await receive(headTg, 'render', { request_id: selection.request_id });
        const offer = choices.reply_markup.inline_keyboard.flat().find((b: any) => b.text === 'Offer to Direct Telegram Worker');
        expect(offer).toBeTruthy();
        await receive(headTg, 'callback', { token_id: offer.callback_data.slice(3) });
        const pending = (await rpc('veo_telegram_intake_pending', [tenant])).find((o: any) => o.telegram_user_id === workerTg);
        expect(pending.chat_id).toBe(chatA);
        const notification = await receive(workerTg, 'render_offer', { offer_id: pending.offer_id });
        const accept = notification.reply_markup.inline_keyboard.flat().find((b: any) => b.text.startsWith('Accept'));
        await receive(workerTg, 'callback', { token_id: accept.callback_data.slice(3) });
        expect((await db.query<any>('SELECT user_id FROM veo_client_claims WHERE contact_id=$1', [customer])).rows[0].user_id).toBe(worker);
        expect((await rpc('veo_telegram_destination', [team, newPage, worker])).chat_id).toBe(chatA);
    });
    it('never grants from usernames, mismatched IDs, unknown membership, stale observations or another branch', async () => {
        await automate([payload(leader, tg + 1, chatA, 'administrator')]);
        for (const observation of [payload(direct, tg + 5, chatA), payload(direct, tg, chatA, 'unknown', { membership_confirmed: false }), payload(direct, tg, chatA, 'member', { observed_at: new Date(Date.now() - 900000).toISOString() })]) await automate([observation]);
        expect(await rpc('veo_can_page', [direct, newPage])).toBe(false);
        await db.query('INSERT INTO veo_worker_mappings VALUES($1,$2)', [other, tg + 2]);
        await automate([payload(other, tg + 2, chatA)]);
        expect((await db.query('SELECT * FROM veo_telegram_auto_grants WHERE user_id=$1', [other])).rows).toHaveLength(0);
    });
    it('preserves manual Pages and access through another group, but removes automatic grants after all confirmed departures', async () => {
        await db.query('INSERT INTO user_pages(user_id,page_id) VALUES($1,$2)', [direct, page]);
        const team = (await db.query<any>('SELECT id FROM veo_teams WHERE manager_id=$1', [leader])).rows[0].id;
        for (const chat of [chatA, chatB]) await rpc('veo_telegram_group_action', [owner, 'group', JSON.stringify({ team_id: team, chat_id: chat, page_ids: [newPage], move_pages: true })]);
        // One team/Page has one route; a second permitted team in the leader's
        // branch may route the same Page through another group for its leader.
        await automate([payload(direct, tg, chatB)]);
        expect(await rpc('veo_can_page', [direct, newPage])).toBe(true);
        await automate([payload(direct, tg, chatB, 'unknown', { membership_confirmed: false })]);
        expect(await rpc('veo_can_page', [direct, newPage])).toBe(true);
        await automate([payload(direct, tg, chatB, 'left', { observed_at: new Date(Date.now() + 100).toISOString() })]);
        expect(await rpc('veo_can_page', [direct, newPage])).toBe(false);
        expect(await rpc('veo_can_page', [direct, page])).toBe(true);
    });
    it('requires a valid one-time link, rejects identity takeover and keeps private functions inaccessible', async () => {
        const another = id(923), hash = 'a'.repeat(64);
        await account(another);
        await rpc('veo_create_telegram_link', [another, hash]);
        expect((await rpc('veo_confirm_telegram_link', [tenant, hash, tg + 3, chatA, 'verified_name'])).linked).toBe(true);
        expect((await rpc('veo_confirm_telegram_link', [tenant, hash, tg + 3, chatA, 'verified_name'])).linked).toBe(true);
        await expect(rpc('veo_confirm_telegram_link', [tenant, hash, tg + 4, chatA, 'forged'])).rejects.toThrow(/already used/);
        await rpc('veo_create_telegram_link', [another, 'b'.repeat(64)]);
        await expect(rpc('veo_confirm_telegram_link', [tenant, 'b'.repeat(64), tg, chatA, null])).rejects.toThrow(/already linked/);
        for (const table of ['veo_telegram_link_codes', 'veo_telegram_auto_grants', 'veo_telegram_auto_states']) expect((await db.query<any>("SELECT has_table_privilege('anon',$1,'SELECT') exposed", [table])).rows[0].exposed).toBe(false);
    });
});
