import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
import { processContactProfiles, profileSourceMessages, safeProfileCursor } from '@/lib/contact-profile-worker';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(() => { vi.stubEnv('OPENROUTER_API_KEY', 'test-key'); vi.clearAllMocks(); });
const source = [
    { id: 'buyer-1', created_time: '2026-10-01T00:00:00Z', from: { id: 'buyer' }, message: 'I need a video for Facebook ads.' },
    { id: 'page-1', created_time: '2026-10-01T01:00:00Z', from: { id: 'fb-page' }, message: 'What format would you prefer?' }
];
function fixture() {
    const rpc = vi.fn(async (name: string) => ({ data: name === 'claim_contact_profile_jobs' ? [{ contact_id: 'c', page_id: 'p', working_version: 1,
        claim_token: 'lease', source_cutoff_at: '2026-10-02T00:00:00Z', scan_started: false, history_complete: false,
        analyzed_count: 0, message_count: 0, partial_analysis: [] }] : true, error: null }));
    const db = { rpc, from: (table: string) => {
        const chain: any = { select: () => chain, eq: () => chain, order: () => chain,
            maybeSingle: async () => ({ data: table === 'pages' ? { fb_page_id: 'fb-page', access_token: 'page-token' } : { psid: 'buyer' }, error: null }),
            range: async () => ({ data: table === 'contact_profile_messages' ? source.map(message => ({ message_id: message.id, sent_at: message.created_time,
                sender: message.from.id === 'buyer' ? 'customer' : 'page', text: message.message, attachment_count: 0, image_count: 0 })) : [], error: null }) };
        return chain;
    } };
    mocks.db.mockReturnValue(db); return rpc;
}

describe('bounded whole-conversation worker', () => {
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
                summary_points: [{ text: 'The customer wants a video for Facebook ads.', evidence: [{ message_id: 'buyer-1', quote: 'video for Facebook ads' }] }],
                facts: [{ category: 'purpose', key: 'Purpose', value: 'Facebook ads', evidence: [{ message_id: 'buyer-1', quote: 'Facebook ads' }] }]
            }) } }] }) });
        vi.stubGlobal('fetch', fetchMock);
        expect(await processContactProfiles({ limit: 1 })).toMatchObject({ processed: 1, ready: 1, failed: 0 });
        const completion = rpc.mock.calls.find(call => call[0] === 'finish_contact_profile_job') as any;
        expect(completion[1].p_payload.conversation.message_count).toBe(2);
        expect(completion[1].p_payload.facts[0].value).toBe('Facebook ads');
        expect(fetchMock.mock.calls[1][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(JSON.parse(fetchMock.mock.calls[1][1].body).response_format.type).toBe('json_schema');
        expect(JSON.stringify(rpc.mock.calls)).not.toContain('page-token');
    });
    it('keeps the prior snapshot when Meta history is unavailable or truncated', async () => {
        const rpc = fixture();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { code: 190 } }) }));
        expect(await processContactProfiles({ limit: 1 })).toMatchObject({ ready: 0, failed: 1 });
        const completion = rpc.mock.calls.find(call => call[0] === 'finish_contact_profile_job') as any;
        expect(completion[1].p_payload).toBeNull(); expect(completion[1].p_error).toContain('renewal');
    });
});
