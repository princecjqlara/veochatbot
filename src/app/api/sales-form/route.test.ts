import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { createSalesFormToken } from '@/lib/chatbot-sales-store';

const mocks = vi.hoisted(() => ({ getSupabaseAdmin: vi.fn(), rpc: vi.fn(), from: vi.fn(), upsert: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
const pageId = '10000000-0000-4000-8000-000000000001';
const contactId = '20000000-0000-4000-8000-000000000002';
const state = { status: 'active', collected_details: { 'Business Name': 'Tea House', 'Contact Number': '09171234567' }, sales_progress: {} };
const request = (method = 'GET', body?: unknown, origin?: string) => new NextRequest('https://agency.test/api/sales-form?token=' + createSalesFormToken(pageId, contactId),
    { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) } });
beforeEach(() => {
    process.env.CHATBOT_FORM_SECRET = 'test-form-secret';
    vi.clearAllMocks();
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.from.mockImplementation((table: string) => {
        const data = table === 'chatbot_configs' ? { commercial_video_intake_enabled: true, sales_assistant_settings: {}, enabled: true, follow_up_enabled: false } :
            table === 'contacts' ? { id: contactId, last_inbound_at: new Date().toISOString(), pipeline_stage: 'engaged' } : state;
        const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data, error: null }), upsert: mocks.upsert };
        return chain;
    });
    mocks.rpc.mockResolvedValue({ data: { state, conflicts: [], duplicate: false }, error: null });
    mocks.getSupabaseAdmin.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
});
afterEach(() => { delete process.env.CHATBOT_FORM_SECRET; });
describe('signed optional customer form', () => {
    it('prefills the same saved contact record without a login or a new lead', async () => {
        const response = await GET(request()); const body = await response.json();
        expect(response.status).toBe(200); expect(body.details['Business Name']).toBe('Tea House'); expect(body.fields).toHaveLength(6);
        expect(body.details['Contact Number']).toBeUndefined();
        expect(response.headers.get('cache-control')).toBe('no-store'); expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('accepts partial answers and queues one response in the existing scheduler', async () => {
        const response = await POST(request('POST', { details: { 'Business Name': 'Tea House' }, base: {}, event_key: 'submission-one' }));
        expect(response.status).toBe(200); expect((await response.json()).response_queued).toBe(true);
        expect(mocks.rpc.mock.calls[0][0]).toBe('merge_chatbot_sales_details');
        expect(mocks.upsert.mock.calls[0][0]).toMatchObject({ contact_id: contactId, purpose: 'form_submission', schedule_type: 'response', sequence_index: 2000 });
        expect(mocks.upsert.mock.calls[0][1].ignoreDuplicates).toBe(true);
    });
    it('exposes conflicts for review and does not queue a stale response', async () => {
        mocks.rpc.mockResolvedValue({ data: { state, conflicts: ['Business Name'], duplicate: false }, error: null });
        const response = await POST(request('POST', { details: { 'Business Name': 'New' }, base: {}, event_key: 'submission-two' }));
        expect(response.status).toBe(409); expect((await response.json()).details['Business Name']).toBe('Tea House'); expect(mocks.upsert).not.toHaveBeenCalled();
    });
    it('saves updates during human takeover without sending or changing ownership', async () => {
        mocks.rpc.mockResolvedValue({ data: { state: { ...state, status: 'stopped', stop_reason: 'manual' }, conflicts: [], duplicate: false }, error: null });
        const response = await POST(request('POST', { details: { 'Business Name': 'Tea House' }, base: {}, event_key: 'submission-three' }));
        expect(response.status).toBe(200); expect(mocks.upsert).not.toHaveBeenCalled();
    });
    it('rejects invalid tokens, cross-origin writes and unconfigured fields', async () => {
        expect((await GET(new NextRequest('https://agency.test/api/sales-form?token=bad'))).status).toBe(401);
        expect((await POST(request('POST', {}, 'https://evil.test'))).status).toBe(403);
        expect((await POST(request('POST', { details: { status: 'active' }, base: {}, event_key: 'submission-four' }))).status).toBe(400);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
});
