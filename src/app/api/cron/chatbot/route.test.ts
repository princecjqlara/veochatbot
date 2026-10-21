import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ db: {}, recover: vi.fn(), tag: vi.fn(), review: vi.fn(), followUp: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => mocks.db }));
vi.mock('@/lib/chatbot-inbound-recovery', () => ({ recoverMissingChatbotMessages: mocks.recover }));
vi.mock('@/lib/messaging-auto-tag-worker', () => ({ processOneMessagingAutoTagPage: mocks.tag }));
vi.mock('@/lib/chatbot-continuation', () => ({ processChatbotContinuationReviews: mocks.review }));
vi.mock('@/lib/chatbot-follow-ups', () => ({ processDueChatbotFollowUps: mocks.followUp }));
import { GET } from './route';

const request = (token?: string) => new NextRequest('https://app.test/api/cron/chatbot', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'scheduled-bot-secret');
    vi.clearAllMocks();
    mocks.recover.mockResolvedValue({ pages: 1, scanned: 4, recovered: 0, failed: 0 });
    mocks.tag.mockResolvedValue({ pages: 1, tagged: 0 });
    mocks.review.mockResolvedValue({ reviewed: 0 });
    mocks.followUp.mockResolvedValue({ checked: 0, sent: 0 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('scheduled live chatbot worker', () => {
    it.each([undefined, 'wrong-secret'])('rejects unauthorized invocations before touching contacts: %s', async token => {
        expect((await GET(request(token))).status).toBe(401);
        for (const worker of [mocks.recover, mocks.tag, mocks.review, mocks.followUp]) expect(worker).not.toHaveBeenCalled();
    });
    it('fails closed when the scheduler secret is missing', async () => {
        vi.stubEnv('CRON_SECRET', '');
        expect((await GET(request('scheduled-bot-secret'))).status).toBe(503);
        expect(mocks.recover).not.toHaveBeenCalled();
    });
    it('recovers inbound messages and refreshes handoffs before continuation and follow-up delivery', async () => {
        const order: string[] = [];
        for (const [name, worker] of Object.entries({ recover: mocks.recover, handoffs: mocks.tag, reviews: mocks.review, followUps: mocks.followUp })) {
            worker.mockImplementationOnce(async () => { order.push(name); return { failed: 0 }; });
        }
        const response = await GET(request('scheduled-bot-secret'));
        expect(response.status).toBe(200);
        expect((await response.json()).success).toBe(true);
        expect(order).toEqual(['recover', 'handoffs', 'reviews', 'followUps']);
        expect(mocks.tag).toHaveBeenCalledWith({ chatbotOnly: true });
        expect(mocks.followUp).toHaveBeenCalledWith({ supabase: mocks.db, limit: 20 });
    });
    it('still checks due follow-ups when a recovery dependency is temporarily unavailable', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.recover.mockRejectedValueOnce(new Error('Meta unavailable'));
        const response = await GET(request('scheduled-bot-secret'));
        expect(response.status).toBe(503);
        expect((await response.json()).inboundRecovery).toEqual({ failed: true, retryable: true });
        expect(mocks.followUp).toHaveBeenCalledTimes(1);
    });
    it('reports a handled recovery failure instead of hiding it behind HTTP 200', async () => {
        mocks.recover.mockResolvedValueOnce({ pages: 1, scanned: 0, recovered: 0, failed: 1 });
        const response = await GET(request('scheduled-bot-secret'));
        expect(response.status).toBe(503);
        expect((await response.json()).success).toBe(false);
        expect(mocks.tag).toHaveBeenCalledTimes(1);
        expect(mocks.followUp).toHaveBeenCalledTimes(1);
    });
});
