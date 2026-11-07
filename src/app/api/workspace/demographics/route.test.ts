import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
import { GET, POST } from './route';
const id = '00000000-0000-4000-8000-000000000001';
beforeEach(() => { m.session.mockResolvedValue({ user: { id: 'owner' } }); m.rpc.mockResolvedValue({ data: { manual_fields: {}, ai_demographics: {} } }); });
afterEach(() => { vi.clearAllMocks(); });
const request = (body: any = {}, origin = 'https://veo.test') => new NextRequest('https://veo.test/api/workspace/demographics', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: id, ...body }) });
it('reads demographics only through the contact-scoped permission RPC', async () => { const r = await GET(new NextRequest('https://veo.test/api/workspace/demographics?contact_id=' + id)); expect(r.status).toBe(200); expect(m.rpc).toHaveBeenCalledWith('veo_demographic_access', { p_actor: 'owner', p_contact: id }); });
it('queues saved-source AI review without claiming a completed demographic profile', async () => { expect((await POST(request({ action: 'refresh' }))).status).toBe(202); });
it('rejects unauthenticated, cross-origin, out-of-scope, and unsupported corrections', async () => {
    expect((await POST(request({ action: 'correct', fields: { religion: 'guess' } }))).status).toBe(400);
    expect((await POST(request({ action: 'refresh' }, 'https://other.test'))).status).toBe(403);
    m.rpc.mockResolvedValue({ error: { code: '42501' } }); expect((await POST(request({ action: 'refresh' }))).status).toBe(403);
    m.session.mockResolvedValue(null); expect((await GET(new NextRequest('https://veo.test/api/workspace/demographics?contact_id=' + id))).status).toBe(401);
});
