import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    processDueFollowUpAutomationSteps: vi.fn(),
    processDueChatbotFollowUps: vi.fn(),
    processOneMessagingAutoTagPage: vi.fn(),
    recoverMissingChatbotMessages: vi.fn(),
    processChatbotContinuationReviews: vi.fn(),ads:vi.fn(),wait:vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/workflow-automations', () => ({
    processDueFollowUpAutomationSteps: mocks.processDueFollowUpAutomationSteps
}));

vi.mock('@/lib/chatbot-follow-ups', () => ({
    processDueChatbotFollowUps: mocks.processDueChatbotFollowUps
}));

vi.mock('@/lib/messaging-auto-tag-worker', () => ({
    processOneMessagingAutoTagPage: mocks.processOneMessagingAutoTagPage
}));
vi.mock('@/lib/chatbot-inbound-recovery', () => ({ recoverMissingChatbotMessages: mocks.recoverMissingChatbotMessages }));
vi.mock('@/lib/chatbot-continuation', () => ({ processChatbotContinuationReviews: mocks.processChatbotContinuationReviews }));
vi.mock('@/lib/veo-scheduled-ads',()=>({runScheduledMetaAds:mocks.ads}));
vi.mock('@vercel/functions',()=>({waitUntil:mocks.wait}));

import { GET } from './route';

describe('GET /api/cron/follow-up-automations', () => {
    afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('VEO_WORKSPACE_ENABLED','false');mocks.ads.mockResolvedValue({complete:true,reports:[]});
        mocks.getSupabaseAdmin.mockReturnValue({ database: true });
        mocks.processDueFollowUpAutomationSteps.mockResolvedValue({ processed: 0 });
        mocks.processDueChatbotFollowUps.mockResolvedValue({ checked: 0, sent: 0 });
        mocks.processOneMessagingAutoTagPage.mockResolvedValue({ pages: 1, conversations: 0, tagged: 0 });
        mocks.recoverMissingChatbotMessages.mockResolvedValue({ recovered: 0 });
        mocks.processChatbotContinuationReviews.mockResolvedValue({ reviewed: 0 });
    });
    it('reuses the existing authorized external route without blocking or removing its ordinary follow-up work',async()=>{
        vi.stubEnv('VEO_WORKSPACE_ENABLED','true');vi.stubEnv('CRON_SECRET','private-cron');
        const pending=new Promise(()=>{});mocks.ads.mockReturnValue(pending);vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({success:true}));
        const response=await GET(new Request('https://veo.test/api/cron/follow-up-automations',{headers:{Authorization:'Bearer private-cron'}}) as NextRequest);
        expect(response.status).toBe(200);expect((await response.json()).meta_ads).toMatchObject({accepted:true,interval_minutes:60,trigger:'existing_follow_up_cron'});
        expect(mocks.ads).toHaveBeenCalledOnce();expect(mocks.wait).toHaveBeenCalledOnce();expect(mocks.processDueFollowUpAutomationSteps).toHaveBeenCalledOnce();expect(mocks.processDueChatbotFollowUps).toHaveBeenCalledOnce();
    });
    it('rejects an unauthorized existing-cron invocation before any ads or message work',async()=>{
        vi.stubEnv('VEO_WORKSPACE_ENABLED','true');vi.stubEnv('CRON_SECRET','private-cron');
        expect((await GET(new Request('https://veo.test/api/cron/follow-up-automations') as NextRequest)).status).toBe(401);expect(mocks.ads).not.toHaveBeenCalled();expect(mocks.processDueFollowUpAutomationSteps).not.toHaveBeenCalled();
    });
    it('keeps ordinary follow-ups working when ads coordination fails',async()=>{
        vi.stubEnv('VEO_WORKSPACE_ENABLED','true');vi.stubEnv('CRON_SECRET','private-cron');mocks.ads.mockRejectedValue(Error('Ads database unavailable'));vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({success:true}));
        const response=await GET(new Request('https://veo.test/api/cron/follow-up-automations',{headers:{Authorization:'Bearer private-cron'}}) as NextRequest);expect(response.status).toBe(200);expect(mocks.processDueChatbotFollowUps).toHaveBeenCalledOnce();
    });

    it('uses the existing minute cron invocation to continue campaigns', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
            success: true,
            processed: 1
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const response = await GET(new Request(
            'https://veobot.vercel.app/api/cron/follow-up-automations'
        ) as NextRequest);
        const body = await response.json();

        expect(fetchMock).toHaveBeenCalledWith(
            new URL('https://veobot.vercel.app/api/cron/campaign-scheduled'),
            expect.objectContaining({ method: 'GET', cache: 'no-store' })
        );
        expect(body.campaignWorker).toEqual(expect.objectContaining({
            ok: true,
            processed: 1
        }));
        expect(mocks.processDueFollowUpAutomationSteps).toHaveBeenCalledTimes(1);
        expect(mocks.processDueChatbotFollowUps).toHaveBeenCalledTimes(1);
        expect(mocks.processOneMessagingAutoTagPage).toHaveBeenCalledTimes(1);
    });

    it('processes follow-ups before invoking the potentially slow campaign worker', async () => {
        const callOrder: string[] = [];
        mocks.recoverMissingChatbotMessages.mockImplementation(async () => {
            callOrder.push('recovery'); return { recovered: 0 };
        });
        mocks.processOneMessagingAutoTagPage.mockImplementation(async () => {
            callOrder.push('stages');
            return { pages: 1 };
        });
        mocks.processDueFollowUpAutomationSteps.mockImplementation(async () => {
            callOrder.push('follow-ups');
            return { processed: 1 };
        });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            callOrder.push('campaigns');
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        });

        await GET(new Request(
            'https://veobot.vercel.app/api/cron/follow-up-automations'
        ) as NextRequest);

        expect(callOrder).toEqual(['recovery', 'stages', 'follow-ups', 'campaigns']);
        expect(mocks.processOneMessagingAutoTagPage).toHaveBeenCalledWith({ chatbotOnly: true });
    });

    it('still processes follow-ups when campaign continuation temporarily fails', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('temporary timeout'));

        const response = await GET(new Request(
            'https://veobot.vercel.app/api/cron/follow-up-automations'
        ) as NextRequest);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.campaignWorker).toEqual(expect.objectContaining({
            ok: false,
            retryable: true
        }));
        expect(mocks.processDueFollowUpAutomationSteps).toHaveBeenCalledTimes(1);
    });

    it('continues ordinary follow-ups when recovery reads fail', async () => {
        mocks.recoverMissingChatbotMessages.mockRejectedValue(new Error('Meta temporarily unavailable'));
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }));
        const response = await GET(new Request('https://veobot.vercel.app/api/cron/follow-up-automations') as NextRequest);
        expect(response.status).toBe(200);
        expect((await response.json()).inboundRecovery.failed).toBe(true);
        expect(mocks.processDueFollowUpAutomationSteps).toHaveBeenCalledTimes(1);
    });
});
