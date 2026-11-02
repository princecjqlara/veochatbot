import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
import { processContactProfiles, profileAnalysisChunk, profileSourceMessages, safeProfileCursor } from '@/lib/contact-profile-worker';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(() => { vi.stubEnv('OPENROUTER_API_KEY', 'test-key'); vi.clearAllMocks(); });
const source = [
    { id: 'buyer-1', created_time: '2026-10-01T00:00:00Z', from: { id: 'buyer' }, message: 'I need a video for Facebook ads.' },
    { id: 'page-1', created_time: '2026-10-01T01:00:00Z', from: { id: 'fb-page' }, message: 'What format would you prefer?' }
];
function fixture(overrides: Record<string, unknown> = {}, storedSource = source, resetAt: string | null = null) {
    const rpc = vi.fn(async (name: string) => ({ data: name === 'claim_contact_profile_jobs' ? [{ contact_id: 'c', page_id: 'p', working_version: 1,
        claim_token: 'lease', source_cutoff_at: '2026-10-02T00:00:00Z', scan_started: false, history_complete: false,
        analyzed_count: 0, message_count: 0, partial_analysis: [], ...overrides }] : true, error: null }));
    const db = { rpc, from: (table: string) => {
        const chain: any = { select: () => chain, eq: () => chain, order: () => chain,
            maybeSingle: async () => ({ data: table === 'pages' ? { fb_page_id: 'fb-page', access_token: 'page-token' } : table === 'chatbot_contact_states' ? { messenger_history_reset_at: resetAt } : { psid: 'buyer' }, error: null }),
            range: async () => ({ data: table === 'contact_profile_messages' ? storedSource.map(message => ({ message_id: message.id, sent_at: message.created_time,
                sender: message.from.id === 'buyer' ? 'customer' : 'page', text: message.message, attachment_count: 0, image_count: 0 })) : [], error: null }) };
        return chain;
    } };
    mocks.db.mockReturnValue(db); return rpc;
}

describe('bounded whole-conversation worker', () => {
    it.each([null, '2026-10-01T01:30:00Z'])('saves older stage history and order notices while respecting reset %s', async resetAt => {
        const notices = [
            { id: 'qualified', created_time: '2026-10-01T01:00:00Z', from: { id: 'fb-page' }, message: 'Lead stage set to Qualified' },
            { id: 'order', created_time: '2026-10-01T02:00:00Z', from: { id: 'fb-page' }, message: 'You created an order for PHP1,000 fb-pma://payments/orderdetails/?invoice_id=123' },
            { id: 'customer-quote', created_time: '2026-10-01T03:00:00Z', from: { id: 'buyer' }, message: 'Lead stage set to Converted' }
        ];
        const rpc = fixture({ history_complete: true, scan_started: true, analyzed_count: 3, message_count: 3,
            partial_analysis: [{ summary_points: [], facts: [], answers: [], excluded: 0 }] }, notices, resetAt);
        vi.stubGlobal('fetch', vi.fn());
        expect(await processContactProfiles({ limit: 1 })).toMatchObject({ ready: 1, failed: 0 });
        const stages = rpc.mock.calls.filter(call => call[0] === 'apply_messenger_lead_stage') as any[];
        expect(stages.map(call => call[1].p_label)).toEqual(resetAt ? ['Order Created'] : ['Qualified', 'Order Created']);
        expect(stages.at(-1)?.[1]).toMatchObject({ p_page_id: 'p', p_contact_id: 'c', p_message_id: 'order', p_stage: 'order_created' });
        expect(fetch).not.toHaveBeenCalled();
    });
    it('retains the prior profile when durable stage history cannot be saved', async () => {
        const rpc = fixture({ history_complete: true, scan_started: true, analyzed_count: 1, message_count: 1 }, [
            { id: 'qualified', created_time: '2026-10-01T01:00:00Z', from: { id: 'fb-page' }, message: 'Lead stage set to Qualified' }
        ]);
        const original = rpc.getMockImplementation()!;
        rpc.mockImplementation(async name => name === 'apply_messenger_lead_stage'
            ? { data: null, error: { message: 'Stage storage unavailable' } } as any : original(name));
        vi.stubGlobal('fetch', vi.fn());
        expect(await processContactProfiles({ limit: 1 })).toMatchObject({ ready: 0, failed: 1 });
        const completion = rpc.mock.calls.find(call => call[0] === 'finish_contact_profile_job') as any;
        expect(completion[1]).toMatchObject({ p_payload: null, p_error: 'Stage storage unavailable' });
        expect(fetch).not.toHaveBeenCalled();
    });
    it('gives an orphan final follow-up its preceding context without counting those messages twice', () => {
        const messages = Array.from({ length: 201 }, (_, index) => ({ id: `message-${index}`, at: '2026-10-01T00:00:00Z', sender: 'page' as const, text: index === 200 ? 'hi ma’am, papagawa po ba kayo?' : 'Previous conversation detail.', attachments: 0 }));
        const chapter = profileAnalysisChunk(messages, 200);
        expect(chapter.advance).toBe(1); expect(chapter.messages.map(message => message.id)).toEqual(['message-195', 'message-196', 'message-197', 'message-198', 'message-199', 'message-200']);
        expect(200 + chapter.advance).toBe(messages.length);
        expect(profileAnalysisChunk(messages, 0).advance).toBe(100);
        expect(profileAnalysisChunk(messages, 100).advance).toBe(100);
    });
    it('validates history cursors and strips access tokens before persistence', () => {
        expect(safeProfileCursor('https://graph.facebook.com/thread/messages?after=abc&access_token=secret')).not.toContain('secret');
        for (const value of ['http://graph.facebook.com/thread/messages', 'https://evil.example/messages', 'https://graph.facebook.com/me/accounts']) expect(() => safeProfileCursor(value)).toThrow();
    });
    it('rejects invalid timestamps and distinguishes image attachments from other files', () => {
        expect(() => profileSourceMessages([{ ...source[0], created_time: 'invalid' }], 'fb-page', 'buyer', '2026-10-02')).toThrow();
        const result = profileSourceMessages([{ ...source[0], attachments: { data: [{ mime_type: 'application/pdf' }, { mime_type: 'image/png' }] } }], 'fb-page', 'buyer', '2026-10-02');
        expect(result[0]).toMatchObject({ sender: 'customer', attachments: 2, images: 1 });
        expect(profileSourceMessages(source, 'fb-page', 'buyer', '2026-09-01')).toHaveLength(0);
    });
    it('publishes grounded structured analysis only after all source messages are processed', async () => {
        const rpc = fixture();
        const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ messages: { data: source } }] }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                summary_points: [{ text: 'The customer wants a video for Facebook ads.', evidence: [{ message_id: 'm1', quote: 'video for Facebook ads' }] }],
                facts: [{ category: 'purpose', key: 'Purpose', value: 'Facebook ads', evidence: [{ message_id: 'm1', quote: 'Facebook ads' }] }]
            }) } }] }) });
        vi.stubGlobal('fetch', fetchMock);
        expect(await processContactProfiles({ limit: 1 })).toMatchObject({ processed: 1, ready: 1, failed: 0 });
        const completion = rpc.mock.calls.find(call => call[0] === 'finish_contact_profile_job') as any;
        expect(completion[1].p_payload.conversation.message_count).toBe(2);
        expect(completion[1].p_payload.facts[0].value).toBe('Facebook ads');
        expect(completion[1].p_payload.facts[0].evidence[0].message_id).toBe('buyer-1');
        expect(fetchMock.mock.calls[1][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(JSON.parse(fetchMock.mock.calls[1][1].body).response_format.type).toBe('json_schema');
        expect(JSON.parse(JSON.parse(fetchMock.mock.calls[1][1].body).messages[1].content).messages[0].id).toBe('m1');
        expect(JSON.stringify(rpc.mock.calls)).not.toContain('page-token');
    });
    it('compacts whole-history chapter citations and restores exact source IDs after merging', async () => {
        const point = { text: 'Customer wants Facebook ads.', evidence: [{ message_id: 'buyer-1', quote: 'video for Facebook ads' }] };
        const rpc = fixture({ history_complete: true, scan_started: true, analyzed_count: 2, message_count: 2,
            partial_analysis: [
                { summary_points: [point], facts: [], answers: [], excluded: 0 },
                { summary_points: [{ text: 'Page asks about format.', evidence: [{ message_id: 'page-1', quote: 'What format' }] }], facts: [], answers: [], excluded: 0 }
            ] });
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: {
            content: JSON.stringify({ summary_points: [{ ...point, evidence: [{ message_id: 'm1', quote: 'video for Facebook ads' }] }], facts: [], answers: [] })
        } }] }) });
        vi.stubGlobal('fetch', fetchMock);
        expect(await processContactProfiles({ limit: 1 })).toMatchObject({ ready: 1, failed: 0 });
        const request = JSON.parse(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1].content);
        expect(request.chapters[0][0].evidence[0].message_id).toBe('m1');
        expect(request.chapters[1][0].evidence[0].message_id).toBe('m2');
        const completion = rpc.mock.calls.find(call => call[0] === 'finish_contact_profile_job') as any;
        expect(completion[1].p_payload.summary_points[0].evidence[0].message_id).toBe('buyer-1');
    });
    it('checkpoints source messages and rejects malformed AI output without publishing a partial snapshot', async () => {
        const rpc = fixture();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ messages: { data: source } }] }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"summary_points":[],"facts":[],"answers":[]} trailing output' } }] }) }));
        expect(await processContactProfiles({ limit: 1 })).toMatchObject({ ready: 0, failed: 1 });
        const saved = rpc.mock.calls.find(call => call[0] === 'save_contact_profile_progress') as any;
        expect(saved[1].p_messages).toHaveLength(2);
        const completion = rpc.mock.calls.find(call => call[0] === 'finish_contact_profile_job') as any;
        expect(completion[1].p_payload).toBeNull(); expect(completion[1].p_error).toBeTypeOf('string');
    });
    it('keeps the prior snapshot when Meta history is unavailable or truncated', async () => {
        const rpc = fixture();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { code: 190 } }) }));
        expect(await processContactProfiles({ limit: 1 })).toMatchObject({ ready: 0, failed: 1 });
        const completion = rpc.mock.calls.find(call => call[0] === 'finish_contact_profile_job') as any;
        expect(completion[1].p_payload).toBeNull(); expect(completion[1].p_error).toContain('renewal');
    });
});
