import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getConversationForPsid: vi.fn() }));
vi.mock('@/lib/facebook', () => ({ getConversationForPsid: mocks.getConversationForPsid }));
import { assertChatbotDeliveryAllowed, ChatbotDeliveryStoppedError } from '@/lib/chatbot-delivery';

function fixture(stage = 'engaged', source = 'chatbot') {
    const writes: Array<{ table: string; payload: any }> = [];
    const contact = { pipeline_stage: stage, pipeline_stage_source: source };
    const db = { from: (table: string) => {
        const chain: any = { select: () => chain, eq: () => chain, in: () => chain,
            maybeSingle: async () => ({ data: table === 'contacts' ? contact : table === 'chatbot_configs'
                ? { enabled: true, follow_up_enabled: true } : null, error: null }),
            upsert: async (payload: any) => { writes.push({ table, payload }); return { error: null }; },
            update: (payload: any) => { writes.push({ table, payload }); return chain; },
            then: (resolve: any) => Promise.resolve({ error: null }).then(resolve)
        };
        return chain;
    } };
    return { contact, writes, input: { supabase: db, pageId: 'page', facebookPageId: 'fb-page',
        accessToken: 'token', contactId: 'contact', psid: 'customer' } };
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('terminal delivery stops', () => {
    it.each(['qualified', 'converted', 'not_qualified', 'order_created', 'opted_out'])(
        'blocks %s without a photo or source exception', async stage => {
            const { input } = fixture(stage);
            await expect(assertChatbotDeliveryAllowed(input)).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
            expect(mocks.getConversationForPsid).not.toHaveBeenCalled();
        }
    );

    it('blocks delivery when a conversation cannot be verified', async () => {
        mocks.getConversationForPsid.mockResolvedValue(null);
        await expect(assertChatbotDeliveryAllowed(fixture().input)).rejects.toThrow('history is unavailable');
    });

    it('honors a stop arriving while an unavailable conversation read is in flight', async () => {
        const { input, contact } = fixture();
        mocks.getConversationForPsid.mockImplementation(async () => { contact.pipeline_stage = 'qualified'; return null; });
        await expect(assertChatbotDeliveryAllowed(input)).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
    });

    it('finds and persists a terminal stage outside the first page at delivery time', async () => {
        const { input, writes } = fixture();
        mocks.getConversationForPsid.mockResolvedValue({ messages: { data: [{ message: 'Thanks', from: { id: 'customer' } }],
            paging: { next: 'https://graph.facebook.com/thread/messages?after=older' } } });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{
            message: 'Lead stage set to Converted', from: { id: 'fb-page' }
        }] }) }));
        await expect(assertChatbotDeliveryAllowed(input)).rejects.toBeInstanceOf(ChatbotDeliveryStoppedError);
        expect(writes).toContainEqual({ table: 'chatbot_contact_states', payload: expect.objectContaining({ status: 'stopped', stop_reason: 'converted' }) });
        expect(writes).toContainEqual({ table: 'chatbot_follow_up_jobs', payload: expect.objectContaining({ status: 'cancelled' }) });
    });
});
