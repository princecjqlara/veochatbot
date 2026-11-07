import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
import { GET, POST } from './route';
const actor = '00000000-0000-4000-8000-000000000001', contact = '00000000-0000-4000-8000-000000000002';
const metadata = () => ({ manual_fields: {}, saved_fields: {}, requested_fields: [], chatbot_fields: ['Phone number'], analysis: { status: 'ready', fields: [] } });
const post = (body: any, origin = 'https://veo.test') => POST(new NextRequest('https://veo.test/api/workspace/profile-details', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: contact, ...body }) }));
beforeEach(() => { m.session.mockResolvedValue({ user: { id: actor } }); m.rpc.mockImplementation(async () => ({ data: metadata() })); });
afterEach(() => { vi.clearAllMocks(); });
it('requires sign-in, a valid contact and same-origin writes', async () => {
    m.session.mockResolvedValue(null); expect((await GET(new NextRequest('https://veo.test/api/workspace/profile-details?contact_id=' + contact))).status).toBe(401);
    m.session.mockResolvedValue({ user: { id: actor } });
    expect((await post({ action: 'refresh' }, 'https://elsewhere.test')).status).toBe(403);
    expect((await post({ action: 'refresh', contact_id: 'invalid' })).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled();
});
it('uses the signed-in actor and propagates current Page denial', async () => {
    m.rpc.mockResolvedValue({ error: { code: '42501' } });
    expect((await post({ action: 'request', label: 'Deadline', actor_id: contact })).status).toBe(403);
    expect(m.rpc).toHaveBeenCalledWith('veo_profile_detail_access', { p_actor: actor, p_contact: contact });
});
it.each(['Phone', 'Customer phone', 'Purpose', 'Problems encountered', 'Age'])('keeps an already tracked %s field instead of adding a duplicate', async label => {
    const r = await post({ action: 'request', label }); expect(r.status).toBe(200); expect((await r.json()).duplicate).toBe(true);
    expect(m.rpc).not.toHaveBeenCalledWith('veo_profile_detail_request', expect.anything());
});
it('requests a missing customer detail with a safe canonical key', async () => {
    const r = await post({ action: 'request', label: 'Delivery deadline' }); expect(r.status).toBe(202);
    expect(m.rpc).toHaveBeenCalledWith('veo_profile_detail_request', { p_actor: actor, p_contact: contact, p_fields: [{ key: 'delivery_deadline', label: 'Delivery deadline' }] });
});
it.each(['Paid amount', 'Lead stage', 'Salary rate', 'Account token'])('never creates an AI financial/control field for %s', async label => {
    expect((await post({ action: 'request', label })).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalledWith('veo_profile_detail_request', expect.anything());
});
it('queues the existing extractor and then rereads the full profile configuration', async () => {
    const r = await post({ action: 'refresh' }); expect(r.status).toBe(202); expect(r.headers.get('cache-control')).toBe('no-store');
    expect(m.rpc).toHaveBeenCalledWith('veo_demographic_action', { p_actor: actor, p_contact: contact, p_action: 'refresh', p_fields: {} });
    expect(m.rpc.mock.calls.filter(c => c[0] === 'veo_profile_detail_access')).toHaveLength(2);
});
