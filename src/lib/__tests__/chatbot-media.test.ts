import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    analyzeInboundCustomerImages,
    analyzeChatbotMedia,
    createChatbotMediaPublicViewUrl,
    getInboundMessengerImageUrls,
    MAX_CHATBOT_MEDIA_BYTES,
    MAX_CHATBOT_MEDIA_FILES_PER_BATCH,
    normalizeChatbotMediaSourcePath,
    DEFAULT_MULTIMODAL_MODEL
} from '@/lib/chatbot-media';

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MULTIMODAL_MODEL;
    delete process.env.PUBLIC_APP_URL;
    delete process.env.NEXTAUTH_URL;
    delete process.env.FACEBOOK_WEBHOOK_URL;
});

describe('VeoBot folder media metadata', () => {
    it('keeps the selected folder and nested relative path for RAG', () => {
        expect(normalizeChatbotMediaSourcePath(
            'Video Samples/Condo/Two Bedroom.mp4',
            'Two Bedroom.mp4'
        )).toEqual({
            sourceFolder: 'Video Samples',
            sourceRelativePath: 'Video Samples/Condo/Two Bedroom.mp4'
        });
    });

    it('removes unsafe path segments and falls back to the filename', () => {
        expect(normalizeChatbotMediaSourcePath('.././', 'Sample.jpg')).toEqual({
            sourceFolder: '',
            sourceRelativePath: 'Sample.jpg'
        });
    });

    it('builds a stable public media URL from the configured app origin', () => {
        process.env.NEXTAUTH_URL = 'https://example.test/dashboard';
        expect(createChatbotMediaPublicViewUrl('asset-id')).toBe('https://example.test/api/chatbot-media/asset-id');
    });

    it('supports practical Supabase folder batches', () => {
        expect(MAX_CHATBOT_MEDIA_BYTES).toBe(50 * 1024 * 1024);
        expect(MAX_CHATBOT_MEDIA_FILES_PER_BATCH).toBe(100);
    });
});

describe('VeoBot media analysis', () => {
    it('extracts only safe image attachment URLs from an inbound Messenger message', () => {
        expect(getInboundMessengerImageUrls({
            attachments: [
                { type: 'image', payload: { url: 'https://cdn.example.test/receipt.jpg' } },
                { type: 'video', payload: { url: 'https://cdn.example.test/demo.mp4' } },
                { type: 'image', payload: { url: 'http://cdn.example.test/insecure.jpg' } },
                { type: 'image', payload: { url: 'not-a-url' } },
                { type: 'image', payload: { url: 'https://cdn.example.test/receipt.jpg' } }
            ]
        })).toEqual(['https://cdn.example.test/receipt.jpg']);
    });

    it('analyzes customer photos with their caption for chatbot context', async () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: 'A receipt showing PHP 150 paid.' } }] })
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(analyzeInboundCustomerImages({
            imageUrls: [
                'https://cdn.example.test/receipt-front.jpg',
                'https://cdn.example.test/receipt-back.jpg'
            ],
            caption: 'Paid na po'
        })).resolves.toBe('A receipt showing PHP 150 paid.');

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.model).toBe(DEFAULT_MULTIMODAL_MODEL);
        expect(body.max_tokens).toBe(1600);
        expect(body.reasoning).toEqual({ effort: 'low' });
        expect(body.messages[0].content).toEqual([
            expect.objectContaining({
                type: 'text',
                text: expect.stringContaining("The customer's accompanying caption is: Paid na po")
            }),
            { type: 'image_url', image_url: { url: 'https://cdn.example.test/receipt-front.jpg' } },
            { type: 'image_url', image_url: { url: 'https://cdn.example.test/receipt-back.jpg' } }
        ]);
    });

    it('reads photo summaries returned as text content parts', async () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: [
                { type: 'text', text: 'A receipt.' },
                { type: 'text', text: 'PHP 150 paid.' }
            ] } }] })
        }));
        await expect(analyzeInboundCustomerImages({
            imageUrls: ['https://cdn.example.test/receipt.jpg']
        })).resolves.toBe('A receipt.\nPHP 150 paid.');
    });

    it('rejects empty analysis instead of pretending the photo was read', async () => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: null } }] })
        }));
        await expect(analyzeInboundCustomerImages({
            imageUrls: ['https://cdn.example.test/receipt.jpg']
        })).rejects.toThrow('OpenRouter returned no customer photo analysis');
    });

    it.each([
        ['image', 'image_url'],
        ['video', 'video_url']
    ] as const)('sends %s input through the configured multimodal model', async (mediaType, contentType) => {
        process.env.OPENROUTER_API_KEY = 'test-key';
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content: 'Visible blue product package.' } }] })
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(analyzeChatbotMedia({
            signedUrl: 'https://storage.example.test/signed-file',
            mediaType,
            title: 'Blue package',
            usageNotes: 'Send when customers ask about the blue option.'
        })).resolves.toBe('Visible blue product package.');

        const request = fetchMock.mock.calls[0][1];
        const body = JSON.parse(request.body);
        expect(body.model).toBe(DEFAULT_MULTIMODAL_MODEL);
        expect(body.messages[0].content[1]).toEqual({
            type: contentType,
            [contentType]: { url: 'https://storage.example.test/signed-file' }
        });
    });
});
