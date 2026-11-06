import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ rpc: vi.fn(), verifyMapping: vi.fn(), jaucianRead: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: async () => ({ user: { id: 'owner' } }) }));
vi.mock('@/lib/veo-jaucian', () => ({ verifyWorkerMapping: m.verifyMapping, jaucianRead: m.jaucianRead }));
import { GET, POST } from './route';
import { philippineDate } from '@/lib/veo-workspace';
afterEach(() => { vi.clearAllMocks(); });
describe('workspace work-date boundaries', () => {
    it('blocks unverified or unauthorized Telegram mappings before changing database state', async () => {
        const request = () => new NextRequest('https://veo.test/api/workspace', { method: 'POST', headers: { Origin: 'https://veo.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mapping', user_id: 'worker', telegram_user_id: '42' }) });
        m.rpc.mockResolvedValue({ data: { user_id: 'owner', tenant_id: 'tenant', role: 'manager', launch_at: 'launched' } });
        expect((await POST(request())).status).toBe(403);
        expect(m.verifyMapping).not.toHaveBeenCalled();
        m.rpc.mockResolvedValue({ data: { user_id: 'owner', tenant_id: 'tenant', role: 'owner', launch_at: 'launched' } });
        m.verifyMapping.mockRejectedValue(Object.assign(new Error('Not a current human member'), { status: 400 }));
        expect((await POST(request())).status).toBe(400);
        expect(m.rpc.mock.calls.every(([name]) => name === 'veo_scope')).toBe(true);
        m.verifyMapping.mockResolvedValue({ verified: true });
        expect((await POST(request())).status).toBe(200);
        expect(m.rpc).toHaveBeenCalledWith('veo_action', expect.objectContaining({ p_action: 'mapping' }));
    });
    it('rejects future target freezing and dates before launch without calculating a salary', async () => {
        const launch = new Date(Date.now() - 86400000).toISOString();
        m.rpc.mockImplementation(async name => ({ data: name === 'veo_scope' ? { user_id: 'owner', role: 'owner', launch_at: launch } : {} }));
        const future = philippineDate(new Date(Date.now() + 30 * 86400000));
        for (const date of ['1970-01-01', future]) expect((await GET(new NextRequest(`https://veo.test/api/workspace?date=${date}`))).status).toBe(400);
        expect(m.rpc.mock.calls.some(([name]) => name === 'veo_dashboard')).toBe(false);
        expect((await GET(new NextRequest('https://veo.test/api/workspace'))).status).toBe(200);
        expect(m.rpc.mock.calls.some(([name]) => name === 'veo_dashboard')).toBe(true);
    });
    it('passes complete server-side deal filters and pagination to the authoritative scoped query', async () => {
        const launch = new Date(Date.now() - 86400000).toISOString(), page = '00000000-0000-4000-8000-000000000001';
        m.rpc.mockImplementation(async name => ({ data: name === 'veo_scope' ? { user_id: 'owner', role: 'owner', launch_at: launch } : name === 'veo_orders_page' ? { orders: [{ id: 'older-order' }], total: 501, offset: 500, limit: 50 } : { orders: [] } }));
        const response = await GET(new NextRequest(`https://veo.test/api/workspace?view=done&offset=500&page_id=${page}&search=client`));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ orders: [{ id: 'older-order' }], order_page: { total: 501, offset: 500 } });
        expect(m.rpc).toHaveBeenCalledWith('veo_orders_page', expect.objectContaining({ p_view: 'done', p_offset: 500, p_page: page, p_search: 'client' }));
        expect(m.rpc).toHaveBeenCalledWith('veo_team_capacity', { p_actor: 'owner', p_day: philippineDate() });
    });
    it('does not silently omit team capacity when the authoritative aggregate is unavailable', async () => {
        m.rpc.mockImplementation(async name => name === 'veo_team_capacity' ? { error: { message: 'Team aggregate unavailable' } } : { data: name === 'veo_scope' ? { user_id: 'owner', role: 'owner', launch_at: new Date(Date.now() - 86400000).toISOString() } : {} });
        const response = await GET(new NextRequest('https://veo.test/api/workspace'));
        expect(response.status).toBe(400); expect((await response.json()).error).toBe('Team aggregate unavailable');
    });
});
