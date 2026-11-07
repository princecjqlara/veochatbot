import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, uuid: (v: string) => /^[0-9a-f-]{36}$/.test(v || '') }));
import { GET, POST } from './route';
const worker = '00000000-0000-4000-8000-000000000001', client = '00000000-0000-4000-8000-000000000002';
const post = (body: any, origin = 'https://veo.test') => POST(new NextRequest('https://veo.test/api/workspace/new-clients', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
beforeEach(() => { m.session.mockResolvedValue({ user: { id: worker } });m.scope.mockResolvedValue({ user_id: worker, launch_at: '2026-11-05' });m.rpc.mockResolvedValue({ data: { saved: true } }); });
afterEach(() => vi.clearAllMocks());
it('authenticates the current actor and passes bounded Page/search filters to the scoped read', async () => {
    const get = () => GET(new NextRequest('https://veo.test/api/workspace/new-clients?view=offers&search=Client&page_id=' + client));
    m.session.mockResolvedValueOnce(null);expect((await get()).status).toBe(401);expect(m.rpc).not.toHaveBeenCalled();
    const r = await get();expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');
    expect(m.rpc).toHaveBeenCalledWith('veo_intake_page', { p_actor: worker, p_view: 'offers', p_page: client, p_search: 'Client', p_offset: 0 });
});
it('rejects invalid actions, filters and cross-origin writes before assignment mutations', async () => {
    expect((await GET(new NextRequest('https://veo.test/api/workspace/new-clients?offset=-1'))).status).toBe(400);
    expect((await post({ action: 'accept', contact_id: client, request_id: worker }, 'https://other.test')).status).toBe(403);
    expect((await post({ action: 'accept', request_id: worker })).status).toBe(400);expect(m.rpc).not.toHaveBeenCalled();
});
it('ignores browser actor/tenant claims and uses the session for Ready and acceptance', async () => {
    expect((await post({ action: 'readiness', status: 'ready', request_id: client, actor: client, tenant_id: client })).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('veo_intake_action', expect.objectContaining({ p_actor: worker, p_action: 'readiness', p_data: expect.objectContaining({ status: 'ready', request_id: client }) }));
    expect((await post({ action: 'accept', contact_id: client, request_id: worker })).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('veo_intake_action', expect.objectContaining({ p_actor: worker, p_action: 'accept' }));
});
it('surfaces current branch denial and conflicting requests and does not accept oversized reassignment notes', async () => {
    m.rpc.mockResolvedValue({ error: { code: '42501', message: 'Client is reserved by another branch' } });
    expect((await post({ action: 'offer', contact_id: client, user_id: worker, request_id: client, reason: 'Move the client' })).status).toBe(403);
    m.rpc.mockClear();expect((await post({ action: 'offer', contact_id: client, user_id: worker, request_id: client, reason: 'x'.repeat(501) })).status).toBe(400);expect(m.rpc).not.toHaveBeenCalled();
});
