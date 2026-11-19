import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ processPage: vi.fn(), processBatch: vi.fn(), workspace: vi.fn(), guard: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({rpc:mocks.rpc}) }));
vi.mock('@/lib/veo-storage-health', () => ({ requireStorageForOptionalWork: mocks.guard }));
vi.mock('@/lib/messaging-auto-tag-worker', () => ({ processOneMessagingAutoTagPage: mocks.processPage, processMessagingStageSyncBatch: mocks.processBatch }));
vi.mock('@/lib/veo-autotag', () => ({ processVeoAutoTags: mocks.workspace }));
import { GET } from './route';
beforeEach(() => { vi.stubEnv('VEO_WORKSPACE_ENABLED','false');mocks.rpc.mockReset().mockResolvedValue({data:true});vi.stubEnv('CRON_SECRET', 'test-secret'); mocks.guard.mockReset().mockResolvedValue({});mocks.processPage.mockReset().mockResolvedValue({ pages: 1, webhookHealth: { verified: true } }); mocks.processBatch.mockReset().mockResolvedValue({pages:6,completed:6,failed:0}); mocks.workspace.mockReset().mockResolvedValue({ pages: 3, completed: 3, failed: 0 }); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('targeted chatbot Page maintenance', () => {
    it('defers rather than starting work when distributed coordination is unavailable',async()=>{
        vi.stubEnv('VEO_WORKSPACE_ENABLED','true');vi.spyOn(console,'warn').mockImplementation(()=>{});mocks.rpc.mockResolvedValue({error:{message:'offline'}});
        const response=await GET(new NextRequest('https://app.test/api/cron/messaging-auto-tag',{headers:{Authorization:'Bearer test-secret'}}));
        expect(response.status).toBe(503);expect(response.headers.get('retry-after')).toBe('60');expect(mocks.workspace).not.toHaveBeenCalled();
    });
    it('does not launch another Page scan while another serverless worker holds the lease',async()=>{
        vi.stubEnv('VEO_WORKSPACE_ENABLED','true');mocks.rpc.mockResolvedValue({data:false});
        const response=await GET(new NextRequest('https://app.test/api/cron/messaging-auto-tag',{headers:{Authorization:'Bearer test-secret'}}));
        expect(response.status).toBe(200);expect(await response.json()).toMatchObject({skipped:true,reason:'already_running'});
        expect(mocks.workspace).not.toHaveBeenCalled();expect(mocks.rpc).toHaveBeenCalledWith('veo_claim_background_job',{p_job:'messaging-auto-tag',p_owner:expect.any(String)});
    });
    it('pauses optional stage-history scans when database resources are under pressure or unknown', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');mocks.guard.mockRejectedValue(Error('Database pressure'));
        const response = await GET(new NextRequest('https://app.test/api/cron/messaging-auto-tag', { headers: { Authorization: 'Bearer test-secret' } }));
        expect(response.status).toBe(503);expect(await response.json()).toMatchObject({ skipped: true, reason: 'database_pressure', retryable: true });
        expect(mocks.workspace).not.toHaveBeenCalled();expect(mocks.processBatch).not.toHaveBeenCalled();
    });
    it('uses bounded workspace recovery without claiming legacy stage scans', async () => {
        vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');
        const response = await GET(new NextRequest('https://app.test/api/cron/messaging-auto-tag', { headers: { Authorization: 'Bearer test-secret' } }));
        expect(await response.json()).toMatchObject({ success: true, pages: 3, completed: 3 });
        expect(mocks.workspace).toHaveBeenCalledOnce();
        expect(mocks.processBatch).not.toHaveBeenCalled();
        expect(mocks.processPage).not.toHaveBeenCalled();
    });
    it('returns a retryable service error for database transport failures', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        mocks.processBatch.mockRejectedValueOnce(new Error('Error: Supabase request timed out'));
        const response = await GET(new NextRequest('https://app.test/api/cron/messaging-auto-tag', { headers: { Authorization: 'Bearer test-secret' } }));
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('60');
        expect(await response.json()).toMatchObject({ success: false, retryable: true });
    });
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
