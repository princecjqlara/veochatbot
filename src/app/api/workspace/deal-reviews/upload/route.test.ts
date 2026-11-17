import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ scope: vi.fn(), rpc: vi.fn(), from: vi.fn(), upload: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc, from: m.from, storage: { from: () => ({ upload: m.upload }) } }) }));
vi.mock('@/lib/veo-deal-review', async original => ({ ...await original<any>(), dealReviewScope: m.scope }));
import { POST } from './route';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let storage: any;
function request(origin = 'https://veo.test', valid = true) {
    const body = new FormData();
    for (const [key, value] of Object.entries({ contact_id: id(2), seller_id: id(1), request_id: id(3), slot: 'payment', receipt_kind: 'done' })) body.set(key, value);
    body.set('photo', new Blob([new Uint8Array(valid ? [255, 216, 255, 224] : [1, 2, 3, 4])], { type: 'image/jpeg' }), 'receipt.jpg');
    return new NextRequest('https://veo.test/api/workspace/deal-reviews/upload', { method: 'POST', headers: { Origin: origin }, body });
}
beforeEach(() => {
    storage = { status: 'unknown', database_bytes: 338900659, optional_work_paused: true, resource_pressure: true, metrics_fresh: false };
    m.scope.mockResolvedValue({ user_id: id(1), tenant_id: id(4), role: 'member', launch_at: '2026-11-05' });
    m.rpc.mockImplementation(async name => ({ data: name === 'veo_storage_status' ? storage : { page_id: id(5) } }));
    m.from.mockImplementation(table => table === 'veo_photo_objects'
        ? { insert: async () => ({ data: null }) }
        : { insert: () => ({ select: () => ({ single: async () => ({ data: { id: id(6), slot: 'payment' } }) }) }) });
    m.upload.mockResolvedValue({ data: {} });
});
afterEach(() => { vi.resetAllMocks(); });
it('allows a member receipt during the live bulk pause after checking seller and Page access', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);expect((await response.json()).photo.id).toBe(id(6));
    expect(m.rpc.mock.calls.map(([name]) => name)).toEqual(['veo_deal_review_context', 'veo_storage_status']);
    expect(m.rpc.mock.calls[0][1]).toEqual({ p_actor: id(1), p_contact: id(2), p_seller: id(1) });
    expect(m.upload).toHaveBeenCalledOnce();
});
it('blocks a critical disk before reserving or uploading an image', async () => {
    storage.status = 'critical';
    const response = await POST(request());
    expect(response.status).toBe(503);expect((await response.json()).error).toContain('nearly full');
    expect(m.from).not.toHaveBeenCalled();expect(m.upload).not.toHaveBeenCalled();
});
it('keeps revoked member access, cross-origin requests and invalid image contents out of storage', async () => {
    expect((await POST(request('https://other.test'))).status).toBe(403);expect(m.scope).not.toHaveBeenCalled();
    expect((await POST(request('https://veo.test', false))).status).toBe(400);
    m.rpc.mockResolvedValue({ error: { code: '42501', message: 'Page access revoked' } });
    expect((await POST(request())).status).toBe(403);
    expect(m.from).not.toHaveBeenCalled();expect(m.upload).not.toHaveBeenCalled();
});
