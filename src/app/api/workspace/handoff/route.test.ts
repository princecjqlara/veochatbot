import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ client: vi.fn(), rpc: vi.fn(), from: vi.fn(), connected: vi.fn(), directory: vi.fn(), refresh: vi.fn(), identity: vi.fn(), storage: { from: vi.fn() } }));
vi.mock('@/lib/veo-facebook-check', () => ({ refreshSubmissionFacebook: m.refresh }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: (signal: AbortSignal) => { m.client(signal); return m; } }));
vi.mock('@/lib/veo-jaucian', () => ({ connectedVeoTenant: m.connected, veoDirectory: m.directory, jaucianRead: m.identity }));
import { GET, POST } from './route';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('temporary photo access for Jaucian', () => {
    it('provides all three reviewed evidence photos as temporary links without exposing object paths', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET','test-key');
        const photos=['stage','payment','order'].map(slot=>({slot,object_path:'private/'+slot}));
        m.rpc.mockResolvedValue({data:{deal_review_id:'review',review_status:'approved',evidence_photos:photos},error:null});
        m.from.mockReturnValue({select:()=>({eq:()=>({single:async()=>({data:{object_path:'private/payment',status:'queued'},error:null})})})});
        m.storage.from.mockReturnValue({createSignedUrl:async(path:string)=>({data:{signedUrl:'https://storage.test/signed/'+path.split('/').at(-1)},error:null})});
        const response=await GET(new NextRequest('https://veo.test/api/workspace/handoff?submission_id=00000000-0000-4000-8000-000000000001',{headers:{Authorization:'Bearer test-key'}}));
        expect(response.status).toBe(200);const body=await response.json();expect(body.evidence_photos).toEqual(photos.map(p=>({slot:p.slot,photo_url:'https://storage.test/signed/'+p.slot})));expect(JSON.stringify(body)).not.toContain('object_path');
    });
    it.each(['submission_id=00000000-0000-4000-8000-000000000001', 'resource=directory&tenant_id=00000000-0000-4000-8000-000000000001'])('cancels a stalled handoff before the bot times out: %s', async query => {
        vi.useFakeTimers(); vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key');
        m.rpc.mockImplementation(() => new Promise(() => {}));
        m.directory.mockImplementation(() => new Promise(() => {}));
        const pending = GET(new NextRequest('https://veo.test/api/workspace/handoff?' + query, { headers: { Authorization: 'Bearer test-key' } }));
        await vi.advanceTimersByTimeAsync(12_000);
        const response = await pending;
        expect(response.status).toBe(503);
        expect(response.headers.get('retry-after')).toBe('30');
        expect(await response.json()).toMatchObject({ retryable: true });
        expect(m.client.mock.calls[0][0].aborted).toBe(true);
        expect(m.storage.from).not.toHaveBeenCalled();
    });
    it('reports a failed tenant read as retryable rather than an invalid workforce payload', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key');
        m.connected.mockRejectedValueOnce(new Error('Error: Supabase request timed out'));
        const response = await POST(new NextRequest('https://veo.test/api/workspace/handoff', { method: 'POST', headers: { Authorization: 'Bearer test-key' },
            body: JSON.stringify({ resource: 'workforce', tenant_id: '00000000-0000-4000-8000-000000000001', workers: [] }) }));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ retryable: true });
        expect(m.rpc).not.toHaveBeenCalled();
    });
    it('keeps invalid JSON and unauthorized input distinct from a database outage', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key');
        const request = (key: string) => new NextRequest('https://veo.test/api/workspace/handoff', { method: 'POST', headers: { Authorization: key }, body: '{bad' });
        expect((await POST(request('Bearer wrong'))).status).toBe(401);
        expect(m.client).not.toHaveBeenCalled();
        expect((await POST(request('Bearer test-key'))).status).toBe(400);
        expect(m.connected).not.toHaveBeenCalled();
    });
    it('does not report a storage outage as a permanently missing photo', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key');
        m.rpc.mockResolvedValue({ data: { order_id: 'order' }, error: null });
        m.from.mockReturnValue({ select: () => ({ eq: () => ({ single: async () => ({ data: { object_path: 'private-photo', status: 'delivered' }, error: null }) }) }) });
        m.storage.from.mockReturnValue({ createSignedUrl: async () => ({ data: null, error: { code: 'SUPABASE_UPSTREAM_522' } }) });
        const response = await GET(new NextRequest('https://veo.test/api/workspace/handoff?submission_id=00000000-0000-4000-8000-000000000001', { headers: { Authorization: 'Bearer test-key' } }));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ retryable: true });
    });
    it('rechecks live human membership and hashes a self-link code before accepting the bot sender identity', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key');vi.stubEnv('VEO_APPROVED_TELEGRAM_CHAT_IDS', '-123');
        m.connected.mockResolvedValue({});m.identity.mockResolvedValue({ verified: true, user_id: 42, chat_id: -123, username: 'actual' });m.rpc.mockResolvedValue({ data: { linked: true } });
        const body = { resource: 'telegram_link', tenant_id: '00000000-0000-4000-8000-000000000001', code: 'a'.repeat(48), telegram_user_id: 42, chat_id: -123 };
        const request = (extra: any = {}) => new NextRequest('https://veo.test/api/workspace/handoff', { method: 'POST', headers: { Authorization: 'Bearer test-key' }, body: JSON.stringify({ ...body, ...extra }) });
        expect((await POST(request())).status).toBe(200);
        expect(m.rpc).toHaveBeenCalledWith('veo_confirm_telegram_link', { p_tenant: body.tenant_id, p_hash: expect.stringMatching(/^[a-f0-9]{64}$/), p_telegram: 42, p_chat: -123, p_username: 'actual' });
        m.rpc.mockClear();expect((await POST(request({ chat_id: -456 }))).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
        m.identity.mockResolvedValue({ verified: true, user_id: 99, chat_id: -123 });expect((await POST(request())).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
    });
    it('authenticates Telegram assignment requests, whitelists inputs and resolves the actor from the numeric mapping', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key');m.connected.mockResolvedValue({});m.rpc.mockResolvedValue({ data: { request_id: 'request' } });
        const body = { resource: 'intake', tenant_id: '00000000-0000-4000-8000-000000000001', chat_id: -123, telegram_user_id: 42, action: 'ready', data: { request_id: '00000000-0000-4000-8000-000000000002', actor_id: 'forged' } };
        const request = (key: string, payload = body) => new NextRequest('https://veo.test/api/workspace/handoff', { method: 'POST', headers: { Authorization: key }, body: JSON.stringify(payload) });
        expect((await POST(request('Bearer wrong'))).status).toBe(401);expect(m.rpc).not.toHaveBeenCalled();
        expect((await POST(request('Bearer test-key'))).status).toBe(200);
        expect(m.rpc).toHaveBeenCalledWith('veo_telegram_intake', { p_tenant: body.tenant_id, p_telegram: 42, p_chat: -123, p_action: 'ready', p_data: { request_id: body.data.request_id, offer_id: undefined, token_id: undefined } });
        m.rpc.mockClear();expect((await POST(request('Bearer test-key', { ...body, chat_id: 123 }))).status).toBe(400);expect(m.rpc).not.toHaveBeenCalled();
        m.connected.mockRejectedValueOnce(Object.assign(Error('Wrong tenant'), { status: 403 }));expect((await POST(request('Bearer test-key'))).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled();
    });
    it('refuses photo access when submission state cannot be checked after eligibility passes', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key'); m.rpc.mockImplementation(async name => ({ data: name === 'veo_handoff' ? { order_id: 'order' } : true }));
        m.from.mockReturnValue({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: Error('Database unavailable') }) }) }) });
        const r = await GET(new NextRequest('https://veo.test/api/workspace/handoff?submission_id=00000000-0000-4000-8000-000000000001', { headers: { Authorization: 'Bearer test-key' } }));
        expect(r.status).toBe(503); expect(m.rpc).toHaveBeenCalledWith('veo_handoff', { p_submission: '00000000-0000-4000-8000-000000000001' }); expect(m.storage.from).not.toHaveBeenCalled();
    });
    it('reports an explicit deleted receipt as permanent cancellation without signing its photo',async()=>{
        vi.stubEnv('VEO_JAUCIAN_SECRET','test-key');m.rpc.mockImplementation(async name=>({data:name==='veo_handoff'?null:true,error:null}));
        const r=await GET(new NextRequest('https://veo.test/api/workspace/handoff?submission_id=00000000-0000-4000-8000-000000000001',{headers:{Authorization:'Bearer test-key'}}));
        expect(r.status).toBe(410);expect((await r.json()).code).toBe('RECEIPT_DELETED');expect(m.storage.from).not.toHaveBeenCalled();
    });
    it('authenticates workforce writes and verifies the connected tenant before accepting observations', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key');
        const payload = { resource: 'workforce', tenant_id: '00000000-0000-4000-8000-000000000001', workers: [] };
        const request = (key: string) => new NextRequest('https://veo.test/api/workspace/handoff', { method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        expect((await POST(request('Bearer wrong-key'))).status).toBe(401);
        expect(m.rpc).not.toHaveBeenCalled(); expect(m.connected).not.toHaveBeenCalled();
        m.connected.mockRejectedValueOnce(Object.assign(new Error('Tenant is not connected'), { status: 403 }));
        expect((await POST(request('Bearer test-key'))).status).toBe(403);
        expect(m.rpc).not.toHaveBeenCalled();
        m.connected.mockResolvedValue({}); m.rpc.mockResolvedValue({ data: { removed: 0 } });
        expect((await POST(request('Bearer test-key'))).status).toBe(200);
        expect(m.rpc).toHaveBeenCalledWith('veo_apply_telegram_observations', { p_tenant: payload.tenant_id, p_payload: payload });
    });
    it('never signs a photo for blocked, expired or deleted submissions even after eligibility is restored', async () => {
        vi.stubEnv('VEO_JAUCIAN_SECRET', 'test-key');
        m.rpc.mockResolvedValue({ data: { order_id: 'order' }, error: null });
        for (const state of [{ status: 'blocked' }, { status: 'expired' }, { status: 'delivered', deleted_at: new Date().toISOString() }]) {
            m.from.mockReturnValue({ select: () => ({ eq: () => ({ single: async () => ({ data: { object_path: 'private-photo', ...state }, error: null }) }) }) });
            const r = await GET(new NextRequest('https://veo.test/api/workspace/handoff?submission_id=00000000-0000-4000-8000-000000000001', { headers: { Authorization: 'Bearer test-key' } }));
            expect(r.status).toBe(state.status === 'delivered' ? 410 : 409);
        }
        expect(m.storage.from).not.toHaveBeenCalled();
    });
});
