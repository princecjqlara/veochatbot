import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildChatbotMessages,
    DEFAULT_CHATBOT_MODEL,
    generateChatbotReply,
    type ChatbotConfig
} from '@/lib/chatbot';

const config: ChatbotConfig = {
    page_id: 'page-db-id',
    enabled: true,
    instructions: 'Answer questions about the salon. Never invent prices.',
    fallback_reply: 'A teammate will reply soon.',
    model: DEFAULT_CHATBOT_MODEL
};

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
});

describe('Tokko chatbot', () => {
    it('builds chronological Messenger context and does not duplicate the current message', () => {
        const messages = buildChatbotMessages({
            instructions: config.instructions,
            contactName: 'CJ',
            pageId: 'page-facebook-id',
            inboundMessage: 'Are you open today?',
            history: [
                {
                    id: 'm3',
                    message: 'Are you open today?',
                    from: { id: 'customer-id', name: 'CJ' },
                    created_time: '2026-09-21T10:02:00Z'
                },
                {
                    id: 'm2',
                    message: 'How can we help?',
                    from: { id: 'page-facebook-id', name: 'Salon' },
                    created_time: '2026-09-21T10:01:00Z'
                },
                {
                    id: 'm1',
                    message: 'Hello',
                    from: { id: 'customer-id', name: 'CJ' },
                    created_time: '2026-09-21T10:00:00Z'
                }
            ]
        });

        expect(messages.map((message) => message.role)).toEqual([
            'system',
            'user',
            'assistant',
            'user'
        ]);
        expect(messages.at(-1)?.content).toBe('Are you open today?');
    });

    it('uses the configured OpenRouter model and returns the generated reply', async () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: 'Yes, we are open today.' } }]
            })
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(generateChatbotReply({
            config,
            pageId: 'page-facebook-id',
            inboundMessage: 'Are you open today?'
        })).resolves.toBe('Yes, we are open today.');

        const request = fetchMock.mock.calls[0][1];
        const body = JSON.parse(request.body);
        expect(body.model).toBe(DEFAULT_CHATBOT_MODEL);
        expect(request.headers.Authorization).toBe('Bearer test-key');
    });

    it('fails closed when the server has no OpenRouter key', async () => {
        await expect(generateChatbotReply({
            config,
            pageId: 'page-facebook-id',
            inboundMessage: 'Hello'
        })).rejects.toThrow('OPENROUTER_API_KEY');
    });
});
