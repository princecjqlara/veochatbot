import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ processPage: vi.fn() }));
vi.mock('@/lib/messaging-auto-tag-worker', () => ({ processOneMessagingAutoTagPage: mocks.processPage }));
import { GET } from './route';
beforeEach(() => { vi.stubEnv('CRON_SECRET', 'test-secret'); mocks.processPage.mockReset().mockResolvedValue({ pages: 1, webhookHealth: { verified: true } }); });
afterEach(() => { vi.unstubAllEnvs(); });
describe('targeted chatbot Page maintenance', () => {
    it('requires the cron secret before repairing subscriptions or tags', async () => {
        const result = await GET(new NextRequest('https://app.test/api/cron/messaging-auto-tag?pageId=page&chatbotOnly=true'));
        expect(result.status).toBe(401);
        expect(mocks.processPage).not.toHaveBeenCalled();
    });
    it('runs enabled-Page safeguards without invoking message-delivery workers', async () => {
        const result = await GET(new NextRequest('https://app.test/api/cron/messaging-auto-tag?pageId=page&chatbotOnly=true', { headers: { Authorization: 'Bearer test-secret' } }));
        expect(result.status).toBe(200);
        expect(mocks.processPage).toHaveBeenCalledWith({ pageId: 'page', chatbotOnly: true });
        expect((await result.json()).webhookHealth.verified).toBe(true);
    });
});
