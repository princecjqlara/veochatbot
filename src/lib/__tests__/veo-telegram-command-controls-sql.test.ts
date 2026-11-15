import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db: PGlite;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
      CREATE SCHEMA app_private;CREATE TABLE app_private.schema_migrations(version text PRIMARY KEY,description text);
      CREATE TABLE veo_telegram_intake_tokens(id uuid PRIMARY KEY,action text,offer_id uuid);
      CREATE TABLE veo_telegram_intake_requests(id uuid PRIMARY KEY,kind text);
      CREATE TABLE fixture_responses(action text PRIMARY KEY,result jsonb);
      CREATE TABLE fixture_calls(action text,payload jsonb);
      CREATE FUNCTION veo_telegram_intake(p_tenant uuid,p_telegram bigint,p_chat bigint,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN IF p_tenant<>'${id(1)}'::uuid THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
      INSERT INTO fixture_calls VALUES(p_action,p_data);RETURN (SELECT result FROM fixture_responses WHERE action=p_action);END $$;
      CREATE FUNCTION veo_intake_notice(p_tenant uuid,p_notice uuid,p_chat bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT result FROM fixture_responses WHERE action='notice' $$;`);
    await db.exec(readFileSync('supabase/migrations/202611150002_veo_telegram_command_controls.sql', 'utf8'));
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
    await db.exec('TRUNCATE fixture_responses,fixture_calls,veo_telegram_intake_tokens,veo_telegram_intake_requests');
    for (const [n, action, offer] of [[2, 'accept', id(20)], [3, 'decline', id(20)], [4, 'ready', null], [5, 'accept', null], [6, 'choose_worker', id(20)]]) {
        await db.query('INSERT INTO veo_telegram_intake_tokens VALUES($1,$2,$3)', [id(n as number), action, offer]);
    }
});
const response = (action: string, result: any) => db.query('INSERT INTO fixture_responses VALUES($1,$2)', [action, result]);
const call = async (action: string, data: any = {}, tenant = id(1)) => (await db.query<any>('SELECT veo_telegram_intake($1,42,-123,$2,$3) result', [tenant, action, data])).rows[0].result;
const button = (n: number) => ({ text: 'Old label', callback_data: 'vi:' + id(n) });
it('renders only the two bound offer controls and explains the non-destructive removal behavior', async () => {
    await response('render_offer', { text: 'Client offer', request_id: id(30), reply_markup: { inline_keyboard: [[button(2), button(3), button(6)], [button(4)], [{ text: 'Open VEO', url: 'https://example.test' }]] } });
    const result = await call('render_offer', { offer_id: id(20) });
    expect(result.reply_markup.inline_keyboard).toEqual([[{ ...button(2), text: 'Accept client' }, { ...button(3), text: 'Remove from list' }]]);
    expect(result.text).toContain('/ready');expect(result.text).toContain('/busy');
    expect(result.text).toContain('declines your offer');expect(result.text).toContain('client remains available for reassignment');
});
it('removes direct pool claims and availability/navigation keyboards from general replies', async () => {
    await response('render', { text: 'Current clients', reply_markup: { inline_keyboard: [[button(4), button(5), button(6)]] } });
    expect((await call('render')).reply_markup.inline_keyboard).toEqual([]);
    await response('notice', { text: 'New client. Use /ready or /busy.', reply_markup: { inline_keyboard: [[{ text: 'Ready', callback_data: 'cw:ready' }]] } });
    const notice = (await db.query<any>('SELECT veo_intake_notice($1,$2,-123) result', [id(1), id(20)])).rows[0].result;
    expect(notice.reply_markup.inline_keyboard).toEqual([]);expect(notice.text).toContain('/ready');
});
it('forwards assignment mutations and stable request IDs once to the existing authoritative implementation', async () => {
    await response('callback', { request_id: id(30), feedback: 'Client accepted. Your status is now Busy. Open My clients to continue.' });
    const data = { request_id: id(30), token_id: id(2) };
    expect(await call('callback', data)).toMatchObject({ request_id: id(30), feedback: 'Client accepted. Your status is now Busy. Use /myclients to continue.' });
    expect((await db.query('SELECT * FROM fixture_calls')).rows).toEqual([{ action: 'callback', payload: data }]);
});
it('propagates authority denials instead of rendering controls for another tenant', async () => {
    await expect(call('render_offer', {}, id(99))).rejects.toMatchObject({ code: '42501' });
});
it('keeps ended announcements absent and both entry points private', async () => {
    expect((await db.query<any>('SELECT veo_intake_notice($1,$2,-123) result', [id(1), id(20)])).rows[0].result).toBeNull();
    for (const signature of ['veo_telegram_intake(uuid,bigint,bigint,text,jsonb)', 'veo_intake_notice(uuid,uuid,bigint)']) {
        expect((await db.query<any>("SELECT has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service", [signature])).rows[0]).toEqual({ anon: false, authenticated: false, service: true });
    }
});
it('directs legacy handover commands to the workspace instead of showing an unusable worker picker', async () => {
    await db.query('INSERT INTO veo_telegram_intake_requests VALUES($1,$2)', [id(30), 'choose_worker']);
    await response('render', { request_id: id(30), text: 'Choose a Ready worker.', reply_markup: { inline_keyboard: [[button(6)]] } });
    const result = await call('render');
    expect(result.text).toContain('workspace to manage handovers');expect(result.text).not.toContain('Choose a Ready worker.');
    expect(result.reply_markup.inline_keyboard).toEqual([]);
});
