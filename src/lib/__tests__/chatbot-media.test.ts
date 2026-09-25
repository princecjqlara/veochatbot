import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    analyzeChatbotMedia,
    createChatbotMediaPublicViewUrl,
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
