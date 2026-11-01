import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ processPage: vi.fn(), processBatch: vi.fn() }));
vi.mock('@/lib/messaging-auto-tag-worker', () => ({ processOneMessagingAutoTagPage: mocks.processPage, processMessagingStageSyncBatch: mocks.processBatch }));
import { GET } from './route';
beforeEach(() => { vi.stubEnv('CRON_SECRET', 'test-secret'); mocks.processPage.mockReset().mockResolvedValue({ pages: 1, webhookHealth: { verified: true } }); mocks.processBatch.mockReset().mockResolvedValue({pages:6,completed:6,failed:0}); });
afterEach(() => { vi.unstubAllEnvs(); });
describe('targeted chatbot Page maintenance', () => {
    it('schedules all connected Pages independently of chatbot enablement', async () => {
        const response = await GET(new NextRequest('https://app.test/api/cron/messaging-auto-tag', { headers: { Authorization: 'Bearer test-secret' } }));
        expect(response.status).toBe(200);
        expect(mocks.processBatch).toHaveBeenCalledOnce();
        expect(mocks.processPage).not.toHaveBeenCalled();
    });
    it('reports individual Page failures so the scheduler does not hide a partial sync', async () => {
        mocks.processBatch.mockResolvedValue({pages:6,completed:5,failed:1});
        const response = await GET(new NextRequest('https://app.test/api/cron/messaging-auto-tag', { headers: { Authorization: 'Bearer test-secret' } }));
        expect(response.status).toBe(503);
        expect((await response.json()).success).toBe(false);
    });
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
