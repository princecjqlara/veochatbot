import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: vi.fn() }));
import { recoverFirstInquiries, earliestCustomerMessage, inquiryHistoryCursor } from '../veo-inquiry-history';
const job = { contact_id: 'contact', page_id: 'page', psid: 'buyer', fb_page_id: '123', access_token: 'private-token', lease_token: 'lease', scan_started: false, cursor: null };
const msg = (id: string, date: string, sender = 'buyer') => ({ id, created_time: date, from: { id: sender } });
const db = () => ({ rpc: vi.fn(async (name: string) => name === 'veo_claim_inquiry_history' ? { data: [job] } : { data: { saved: true, complete: true, changed: true } }) });
afterEach(() => { vi.unstubAllGlobals(); });
it('finds the oldest customer message and ignores earlier Page-authored messages', () => {
    expect(earliestCustomerMessage([msg('page', '2025-01-01', '123'), msg('new', '2026-11-13'), msg('first', '2026-08-01')], 'buyer')).toEqual({ at: '2026-08-01T00:00:00.000Z', id: 'first' });
    expect(earliestCustomerMessage([msg('new', '2026-11-13')], 'buyer', { at: '2026-08-01T00:00:00Z', id: 'first' })?.id).toBe('first');
});
it('follows every accessible page before confirming the first inquiry and never requests message text', async () => {
    const database = db(), next = 'https://graph.facebook.com/v24.0/thread/messages?after=old&access_token=do-not-store';
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: 'thread', messages: { data: [msg('new', '2026-11-13')], paging: { next } } }] }))
        .mockResolvedValueOnce(Response.json({ data: [msg('page', '2025-01-01', '123'), msg('original', '2026-08-01')] }));
    vi.stubGlobal('fetch', fetcher);
    expect(await recoverFirstInquiries(database)).toMatchObject({ checked: 1, changed: 1, failed: 0 });
    const checkpoint = database.rpc.mock.calls.find(c => c[0] === 'veo_finish_inquiry_history') as any;
    expect(checkpoint[1]).toMatchObject({ p_first: '2026-08-01T00:00:00.000Z', p_message: 'original', p_complete: true, p_cursor: null });
    const initial = fetcher.mock.calls[0][0] as URL; expect(initial.searchParams.get('fields')).not.toContain('message,');
    for (const call of fetcher.mock.calls) expect(String(call[0])).not.toContain('access_token');
});
it('checkpoints long history without presenting a partial scan as verified', async () => {
    const database = db(); database.rpc.mockImplementation(async (name: string) => name === 'veo_claim_inquiry_history' ? { data: [job] } : { data: { saved: true, complete: false, changed: false } });
    let page = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { page++; const messages = { data: [msg('message-' + page, '2026-01-01')], paging: { next: 'https://graph.facebook.com/v24.0/thread/messages?after=' + page } }; return Response.json(page === 1 ? { data: [{ messages }] } : messages); }));
    expect(await recoverFirstInquiries(database)).toMatchObject({ checked: 0, pending: 1 });
    const checkpoint = database.rpc.mock.calls.find(c => c[0] === 'veo_finish_inquiry_history') as any;
    expect(checkpoint[1].p_complete).toBe(false); expect(checkpoint[1].p_cursor).toContain('/messages?after='); expect(page).toBe(6);
});
it('rejects foreign cursors and retains a retryable failure when history is inaccessible', async () => {
    expect(() => inquiryHistoryCursor('https://example.com/messages?access_token=secret')).toThrow('Invalid');
    expect(inquiryHistoryCursor('https://graph.facebook.com/v24.0/thread/messages?after=x&access_token=secret')).not.toContain('secret');
    const database = db();vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 190 } }, { status: 400 })));
    await recoverFirstInquiries(database);
    const checkpoint = database.rpc.mock.calls.find(c => c[0] === 'veo_finish_inquiry_history') as any;
    expect(checkpoint[1]).toMatchObject({ p_first: null, p_message: null, p_complete: false }); expect(checkpoint[1].p_error).toContain('Page connection');
});
