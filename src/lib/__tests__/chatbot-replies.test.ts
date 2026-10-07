import { describe, expect, it, vi } from 'vitest';
import { claimChatbotReply } from '@/lib/chatbot-replies';

describe('chatbot reply retries', () => {
    const input = { inboundMessageId: 'inbound', pageId: 'page', contactId: 'contact' };
    function fixture(result: { data: unknown; error: unknown }) {
        const filters: Record<string, unknown> = {};
        const chain: any = {
            update: vi.fn(() => chain), select: () => chain,
            eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
            is: (key: string, value: unknown) => { filters[key] = value; return chain; },
            maybeSingle: async () => result,
            insert: async () => ({ error: { code: '23505' } })
        };
        return { db: { from: () => chain }, filters };
    }
    it('reclaims only failed events that have not delivered a message', async () => {
        const { db, filters } = fixture({ data: { inbound_message_id: 'inbound' }, error: null });
        expect(await claimChatbotReply(db, input)).toBe(true);
        expect(filters).toEqual({ inbound_message_id: 'inbound', page_id: 'page', contact_id: 'contact', status: 'failed', outbound_message_id: null });
    });
    it('leaves sent, processing, partially sent, and concurrently claimed events alone', async () => {
        const { db } = fixture({ data: null, error: null });
        expect(await claimChatbotReply(db, input)).toBe(false);
    });
    it('surfaces a failed retry claim for webhook redelivery', async () => {
        const { db } = fixture({ data: null, error: { message: 'Database unavailable' } });
        await expect(claimChatbotReply(db, input)).rejects.toThrow('Database unavailable');
    });
});
