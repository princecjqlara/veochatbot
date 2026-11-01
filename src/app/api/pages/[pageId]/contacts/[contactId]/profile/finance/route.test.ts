import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), db: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.session }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: mocks.access }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
import { POST } from './route';
const scope = { params: Promise.resolve({ pageId: 'page', contactId: 'contact' }) };
const payload = { action: 'payment', request_id: '00000000-0000-4000-8000-000000000001', amount: '150.00', currency: 'PHP',
    kind: 'deposit', occurred_at: '2026-10-01T00:00:00Z', reference: 'GCASH-REF-001', confirmed: true };
const req = (body: any, origin = 'https://app.test') => new NextRequest('https://app.test/api/pages/page/contacts/contact/profile/finance', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body)
});
beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue({ user: { id: 'member' } }); mocks.access.mockResolvedValue(true);
    mocks.rpc.mockResolvedValue({ data: { id: 'payment' }, error: null }); mocks.db.mockReturnValue({ rpc: mocks.rpc }); });
describe('verified finance permissions and user confirmation', () => {
    it('rejects unauthenticated users and unrelated Page members before reading finance records', async () => {
        mocks.session.mockResolvedValue(null); expect((await POST(req(payload), scope)).status).toBe(401);
        mocks.session.mockResolvedValue({ user: { id: 'member' } }); mocks.access.mockResolvedValue(false);
        expect((await POST(req(payload), scope)).status).toBe(403); expect(mocks.db).not.toHaveBeenCalled();
    });
    it('requires a same-origin request, explicit verification, exact money and a transaction reference', async () => {
        expect((await POST(req(payload, 'https://evil.example'), scope)).status).toBe(403);
        for (const body of [{ ...payload, confirmed: false }, { ...payload, amount: '-150' }, { ...payload, reference: '' }, { ...payload, amount: '150.001' }])
            expect((await POST(req(body), scope)).status).toBe(400);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('uses the authenticated verifier and integer cents rather than any actor supplied by the client', async () => {
        expect((await POST(req({ ...payload, verified_by: 'forged-user' }), scope)).status).toBe(200);
        expect(mocks.rpc).toHaveBeenCalledWith('record_contact_verified_payment', expect.objectContaining({ p_actor_id: 'member', p_amount_minor: 15000, p_reference: payload.reference }));
    });
    it('reports duplicate transaction references without creating a second payment', async () => {
        mocks.rpc.mockResolvedValue({ error: { code: '23505' } });
        expect((await POST(req(payload), scope)).status).toBe(409);
    });
});
