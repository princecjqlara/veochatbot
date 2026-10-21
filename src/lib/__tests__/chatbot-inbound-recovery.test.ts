import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverMissingChatbotMessages } from '@/lib/chatbot-inbound-recovery';

const now = new Date('2026-10-17T10:00:00Z');
const claim = { page_id: 'page', enabled_at: '2026-10-17T09:50:00Z', scan_cursor: null, lease_until: '2026-10-17T10:03:00Z' };
const message = (id = 'real-mid', from = 'customer', at = '2026-10-17T09:59:00Z') => ({ id, from: { id: from }, created_time: at, message: 'How much?' });
const thread = (messages = [message()]) => ({ id: 'thread', messages: { data: messages }, updated_time: messages[0]?.created_time });
function setup(options: { claims?: unknown[]; threads?: unknown[]; reply?: unknown; afterDispatchReply?: unknown; saved?: unknown; hot?: boolean; dispatchStatus?: number } = {}) {
    const writes: Array<{ table: string; kind: string; value: any }> = [];
    let dispatched = false;
    const db = { rpc: vi.fn().mockResolvedValue({ data: options.claims || [claim], error: null }), from: vi.fn((table: string) => {
        const query: any = {};
        for (const method of ['select', 'eq', 'gte', 'order', 'limit', 'in']) query[method] = vi.fn(() => query);
        for (const method of ['update', 'upsert']) query[method] = vi.fn((value: unknown) => { writes.push({ table, kind: method, value }); return query; });
        const result = () => ({ error: null, data: table === 'pages' ? { id: 'page', fb_page_id: 'fb-page', access_token: 'secret' }
            : table === 'chatbot_reply_events' ? dispatched ? options.afterDispatchReply || { status: 'sent', outbound_message_id: 'delivered' } : options.reply || null
            : table === 'chatbot_inbound_recovery_events' ? options.saved || null
            : table === 'chatbot_contact_states' ? options.hot ? [{ contact_id: 'contact' }] : []
            : table === 'contacts' ? [{ psid: 'customer' }] : null });
        query.single = query.maybeSingle = vi.fn(async () => result());
        query.then = (resolve: any) => Promise.resolve(result()).then(resolve);
        return query;
    }) };
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ data: options.threads || [thread()] }));
    vi.stubGlobal('fetch', fetchMock);
    const dispatch = vi.fn().mockImplementation(async () => { dispatched = true; return new Response('', { status: options.dispatchStatus || 200 }); });
    return { db, writes, fetchMock, dispatch, run: () => recoverMissingChatbotMessages({ supabase: db, now, dispatch }) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('missed Messenger inbound recovery', () => {
    it('preserves webhook milliseconds for the same message instead of falsely treating its retry as stale', async () => {
        const precise='2026-10-17T09:59:00.825Z';
        const fixture=setup({reply:{status:'failed',outbound_message_id:null,inbound_at:precise}});
        await fixture.run();
        expect(fixture.dispatch.mock.calls[0][0].entry[0].messaging[0].timestamp).toBe(Date.parse(precise));
        expect(fixture.writes.find(write=>write.kind==='upsert')?.value.inbound_at).toBe(precise);
    });
    it('does not substitute a saved timestamp from a different second', async () => {
        const fixture=setup({reply:{status:'failed',outbound_message_id:null,inbound_at:'2026-10-17T09:58:00.825Z'}});
        await fixture.run();
        expect(fixture.dispatch.mock.calls[0][0].entry[0].messaging[0].timestamp).toBe(Date.parse('2026-10-17T09:59:00Z'));
    });
    it('recovers an unanswered timeout failure after an outage lasting longer than fifteen minutes', async () => {
        const fixture = setup({ claims:[{...claim,enabled_at:'2026-10-16T08:00:00Z'}],
            threads:[thread([message('outage-inbound','customer','2026-10-17T02:00:00Z')])],
            reply:{status:'failed',outbound_message_id:null} });
        expect(await fixture.run()).toMatchObject({recovered:1,failed:0});
        expect(fixture.dispatch.mock.calls[0][0].entry[0].messaging[0].timestamp).toBe(Date.parse('2026-10-17T02:00:00Z'));
    });
    it('does not recover an inquiry outside the 24-hour response window after a long outage', async () => {
        const fixture = setup({ claims:[{...claim,enabled_at:'2026-10-15T08:00:00Z'}],
            threads:[thread([message('expired-inbound','customer','2026-10-16T09:59:59Z')])],
            reply:{status:'failed',outbound_message_id:null} });
        await fixture.run(); expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it('does not mark a retryable failed reply done just because the webhook returned HTTP 200', async () => {
        const fixture = setup({ reply:{status:'failed',outbound_message_id:null},
            afterDispatchReply:{status:'failed',outbound_message_id:null,error_message:'Database temporarily unavailable'} });
        expect(await fixture.run()).toMatchObject({recovered:0,failed:1});
        expect(fixture.writes.some(write=>write.value.status==='done')).toBe(false);
        expect(fixture.writes.find(write=>write.value.status==='failed')?.value.error_message).toBe('Database temporarily unavailable');
    });
    it('reuses the real ID, customer, Page, text, and timestamp through the ordinary webhook', async () => {
        const fixture = setup();
        expect(await fixture.run()).toMatchObject({ pages: 1, recovered: 1, failed: 0 });
        expect(fixture.dispatch).toHaveBeenCalledWith({ object: 'page', entry: [{ id: 'fb-page', messaging: [{
            sender: { id: 'customer' }, recipient: { id: 'fb-page' }, timestamp: Date.parse('2026-10-17T09:59:00Z'),
            message: { mid: 'real-mid', text: 'How much?' }
        }] }] });
        expect(fixture.writes.some(write => write.value.status === 'done')).toBe(true);
        expect(fixture.writes.at(-1)?.value).toMatchObject({ lease_until: null, last_error: null });
    });
    it.each([
        { status: 'sent' }, { status: 'processing' }, { status: 'failed', outbound_message_id: 'already-delivered' }
    ])('never duplicates a delivered or in-flight reply: %j', async reply => {
        const fixture = setup({ reply }); await fixture.run(); expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it.each([
        { status: 'done', attempt_count: 1 }, { status: 'failed', attempt_count: 3 },
        { status: 'processing', attempt_count: 1, updated_at: '2026-10-17T09:59:00Z' }
    ])('honors durable recovery dedupe and retry bounds: %j', async saved => {
        const fixture = setup({ saved }); await fixture.run(); expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it.each(['2026-10-17T09:49:59Z', '2026-10-17T10:00:01Z', '2026-10-17T09:59:58Z'])('does not replay pre-activation, future, or in-flight events at %s', async at => {
        const fixture = setup({ threads: [thread([message('mid', 'customer', at)])] });
        await fixture.run(); expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it('leaves an inquiry alone when staff or the bot has already answered it', async () => {
        const fixture = setup({ threads: [thread([message('outbound', 'fb-page', '2026-10-17T09:59:30Z'), message()])] });
        await fixture.run(); expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it('retries a handler failure with no delivered reply and records failure for visibility', async () => {
        const fixture = setup({ reply: { status: 'failed', outbound_message_id: null }, saved: { status: 'failed', attempt_count: 1 }, dispatchStatus: 503 });
        expect(await fixture.run()).toMatchObject({ failed: 1, recovered: 0 });
        expect(fixture.writes.find(write => write.kind === 'upsert')?.value.attempt_count).toBe(2);
        expect(fixture.writes.find(write => write.value.status === 'failed')?.value.error_message).toContain('503');
        expect(fixture.writes.at(-1)?.value.last_error).toContain('503');
    });
    it('polls known active contacts independently when campaigns bury the live thread', async () => {
        const fixture = setup({ hot: true, threads: [] });
        fixture.fetchMock.mockResolvedValueOnce(Response.json({ data: [] })).mockResolvedValueOnce(Response.json({ data: [thread()] }));
        expect(await fixture.run()).toMatchObject({ recovered: 1 });
        expect(fixture.fetchMock.mock.calls[1][0]).toContain('user_id=customer');
    });
    it('does not dispatch anything without an opted-in enabled Page claim', async () => {
        const fixture = setup({ claims: [] });
        expect(await fixture.run()).toMatchObject({ pages: 0, recovered: 0 });
        expect(fixture.fetchMock).not.toHaveBeenCalled(); expect(fixture.dispatch).not.toHaveBeenCalled();
    });
    it('fails closed on a Meta read failure and releases the Page lease', async () => {
        const fixture = setup(); fixture.fetchMock.mockRejectedValue(new Error('Meta timeout'));
        expect(await fixture.run()).toMatchObject({ failed: 1, recovered: 0 });
        expect(fixture.dispatch).not.toHaveBeenCalled();
        expect(fixture.writes.at(-1)?.value).toMatchObject({ lease_until: null, last_error: 'Meta timeout' });
    });
    it('processes at most one actual event per tick', async () => {
        const fixture = setup({ threads: [thread(), { ...thread([message('other-mid')]), id: 'other-thread' }] });
        await fixture.run(); expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    });
    it('preserves actual image attachments when the customer sends a photo without text', async () => {
        const photo = { ...message(), message: '', attachments: { data: [{ mime_type: 'image/jpeg', image_data: { url: 'https://example.com/customer-photo.jpg' } }] } };
        const fixture = setup({ threads: [thread([photo])] });
        await fixture.run();
        expect(fixture.dispatch.mock.calls[0][0].entry[0].messaging[0].message).toEqual({ mid: 'real-mid',
            attachments: [{ type: 'image', payload: { url: 'https://example.com/customer-photo.jpg' } }] });
    });
    it('always reads the current conversation head even when a previous cursor exists', async () => {
        const fixture = setup({ claims: [{ ...claim, scan_cursor: 'older-cursor' }] });
        fixture.fetchMock.mockResolvedValueOnce(Response.json({ data: [thread()] }))
            .mockResolvedValueOnce(Response.json({ data: [], paging: { cursors: { after: 'next-cursor' }, next: 'https://example.com/next' } }));
        expect(await fixture.run()).toMatchObject({ recovered: 1 });
        expect(fixture.fetchMock.mock.calls[0][0]).not.toContain('after=');
        expect(fixture.fetchMock.mock.calls[1][0]).toContain('after=older-cursor');
        expect(fixture.writes.at(-1)?.value.scan_cursor).toBe('next-cursor');
    });
    it('processes three leased Pages concurrently so one slow reply cannot block other Pages', async () => {
        const fixture = setup({ claims: ['one','two','three'].map(page_id => ({ ...claim, page_id })) });
        let running = 0, maximum = 0;
        fixture.dispatch.mockImplementation(async () => {
            running++; maximum = Math.max(maximum, running);
            await new Promise(resolve => setTimeout(resolve, 10));
            running--; return new Response('', { status: 200 });
        });
        expect(await fixture.run()).toMatchObject({ pages: 3, recovered: 3, failed: 0 });
        expect(maximum).toBe(3);
        expect(fixture.db.rpc).toHaveBeenCalledWith('claim_chatbot_inbound_recovery_pages', { p_limit: 3, p_now: now.toISOString() });
        expect(fixture.writes.filter(write => write.table === 'chatbot_inbound_recovery_pages' && write.value.lease_until === null)).toHaveLength(3);
    });
    it('continues the other Pages when one Page token fails', async () => {
        const fixture = setup({ claims: ['one','two','three'].map(page_id => ({ ...claim, page_id })) });
        fixture.fetchMock.mockRejectedValueOnce(new Error('Page token expired'));
        expect(await fixture.run()).toMatchObject({ pages: 3, recovered: 2, failed: 1 });
        expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    });
});
