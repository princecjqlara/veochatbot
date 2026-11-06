import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc }) }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
import { GET } from './route';
afterEach(() => { vi.clearAllMocks(); });
describe('workspace contact search', () => {
    it('returns the items contract with no-store and searches all authorized pages using the signed-in actor', async () => {
        m.session.mockResolvedValue({ user: { id: 'worker' } });
        m.rpc.mockResolvedValue({ data: { items: [{ id: 'no-order-client' }], total: 1, offset: 25 } });
        const response = await GET(new NextRequest('https://veo.test/api/workspace/contacts?search=%20Alice%20&offset=25&actor=owner'));
        expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toMatchObject({ items: [{ id: 'no-order-client' }] });
        expect(m.rpc).toHaveBeenCalledWith('veo_contacts_page', { p_actor: 'worker', p_search: 'Alice', p_page: null, p_offset: 25, p_limit: 25 });
    });
    it('rejects anonymous access, invalid filters and revoked page access', async () => {
        m.session.mockResolvedValue(null); expect((await GET(new NextRequest('https://veo.test/api/workspace/contacts'))).status).toBe(401);
        m.session.mockResolvedValue({ user: { id: 'worker' } });
        expect((await GET(new NextRequest('https://veo.test/api/workspace/contacts?offset=-1'))).status).toBe(400);
        m.rpc.mockResolvedValue({ error: { code: '42501' } });
        expect((await GET(new NextRequest('https://veo.test/api/workspace/contacts?page_id=00000000-0000-4000-8000-000000000001'))).status).toBe(403);
    });
});
