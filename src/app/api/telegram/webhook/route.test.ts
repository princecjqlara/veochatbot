import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    ingestTelegramMedia: vi.fn()
}));

vi.mock('@/lib/telegram-media', () => ({
    ingestTelegramMedia: mocks.ingestTelegramMedia
}));

import { parseTelegramMediaRoutes } from '@/lib/telegram-config';
import { POST } from './route';

const pageId = 'd3f40d05-aa54-498e-bff7-e9c4410b7471';
const chatId = -1001234567890;

function request(body: unknown, secret = 'telegram-secret') {
    return new Request('http://localhost/api/telegram/webhook', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-telegram-bot-api-secret-token': secret
        },
        body: JSON.stringify(body)
    }) as NextRequest;
}

describe('Telegram media webhook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('TELEGRAM_BOT_TOKEN', '123456:test-token');
        vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'telegram-secret');
        vi.stubEnv('TELEGRAM_MEDIA_ROUTES', JSON.stringify({ [chatId]: pageId }));
        mocks.ingestTelegramMedia.mockResolvedValue({ status: 'ready', asset: { id: 'asset_1' } });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('rejects requests without the configured Telegram secret', async () => {
        const response = await POST(request({}, 'wrong-secret'));

        expect(response.status).toBe(401);
        expect(mocks.ingestTelegramMedia).not.toHaveBeenCalled();
    });

    it('imports media from a mapped group into its Page', async () => {
        const message = {
            message_id: 9,
            chat: { id: chatId, title: 'Media source', type: 'supergroup' },
            photo: [{ file_id: 'file_1', file_unique_id: 'unique_1', file_size: 1000 }]
        };
        const response = await POST(request({ update_id: 7, message }));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expect.objectContaining({ ok: true, status: 'ready' }));
        expect(mocks.ingestTelegramMedia).toHaveBeenCalledWith({
            botToken: '123456:test-token',
            pageId,
            message
        });
    });

    it('ignores Telegram groups that are not explicitly mapped', async () => {
        const response = await POST(request({
            update_id: 8,
            channel_post: { message_id: 10, chat: { id: -1009999999999, type: 'channel' } }
        }));

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expect.objectContaining({ status: 'ignored' }));
        expect(mocks.ingestTelegramMedia).not.toHaveBeenCalled();
    });

    it('validates the group-to-Page routing configuration', () => {
        expect(parseTelegramMediaRoutes(JSON.stringify({ [chatId]: pageId }))).toEqual({
            [String(chatId)]: pageId
        });
        expect(() => parseTelegramMediaRoutes('{bad json')).toThrow('must be valid JSON');
        expect(() => parseTelegramMediaRoutes(JSON.stringify({ group: pageId }))).toThrow('invalid chat ID');
    });
});
