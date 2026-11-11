import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn(), from: vi.fn(), refresh: vi.fn(), storage: { from: vi.fn() } }));
vi.mock('@/lib/veo-facebook-check', () => ({ refreshReceiptFacebook: m.refresh }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, uuid: (v: string) => /^[0-9a-f-]{36}$/.test(v || ''), philippineDate: () => '2026-11-07' }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
import { GET, POST } from './route';
const worker = '00000000-0000-4000-8000-000000000001', receipt = '00000000-0000-4000-8000-000000000002';
const get = (q = 'commission=1') => GET(new NextRequest('https://veo.test/api/workspace/receipts?' + q));
const post = (body: any, origin = 'https://veo.test') => POST(new NextRequest('https://veo.test/api/workspace/receipts', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
beforeEach(() => { m.session.mockResolvedValue({ user: { id: worker } }); m.scope.mockResolvedValue({ user_id: worker, role: 'member', launch_at: '2026-11-05', worker_ids: [worker] }); m.rpc.mockResolvedValue({ data: { rate: 35, target: 1, closed: 0, done: 0, totals: [] } }); });
afterEach(() => { vi.clearAllMocks(); });
it('requires authentication and passes the session actor to the branch-authorized commission read', async () => {
    m.session.mockResolvedValue(null); expect((await get()).status).toBe(401); expect(m.rpc).not.toHaveBeenCalled();
    m.session.mockResolvedValue({ user: { id: worker } });
    const r = await get(); expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store'); expect(m.rpc).toHaveBeenCalledWith('veo_receipt_commission', { p_actor: worker, p_seller: worker, p_day: '2026-11-07' });
});
it('rejects malformed dates and surfaces branch denial without exposing commission', async () => {
    expect((await get('commission=1&date=2026-02-30')).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled();
    m.rpc.mockResolvedValue({ error: { code: '42501', message: 'Commission outside your seller branch' } });
    expect((await get('commission=1&worker_id=' + receipt)).status).toBe(403);
});
it('saves scoped receipt notes without uploading a photo or writing payment', async () => {
    expect((await post({ action: 'notes', receipt_id: receipt, notes: 'Balance expected tomorrow' })).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('veo_receipt_note', { p_actor: worker, p_id: receipt, p_notes: 'Balance expected tomorrow' }); expect(m.from).not.toHaveBeenCalled(); expect(m.storage.from).not.toHaveBeenCalled();
});
it('denies cross-origin notes, oversized notes and revoked receipt access', async () => {
    expect((await post({ action: 'notes', receipt_id: receipt, notes: 'Edit' }, 'https://other.test')).status).toBe(403);
    expect((await post({ action: 'notes', receipt_id: receipt, notes: 'a'.repeat(2001) })).status).toBe(400); expect(m.rpc).not.toHaveBeenCalled();
    m.rpc.mockResolvedValue({ error: { code: '42501', message: 'Receipt outside your branch' } }); expect((await post({ action: 'notes', receipt_id: receipt, notes: 'Edit' })).status).toBe(403);
});
it('deletes only through the session actor and validates reasons, Page access and request origin',async()=>{
    expect((await post({action:'delete',receipt_id:receipt,reason:'Wrong photo',cancel_closed:false})).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith('veo_receipt_delete',{p_actor:worker,p_id:receipt,p_reason:'Wrong photo',p_cancel_closed:false});
    m.rpc.mockClear();expect((await post({action:'delete',receipt_id:receipt,reason:'',cancel_closed:false})).status).toBe(400);expect(m.rpc).not.toHaveBeenCalled();
    expect((await post({action:'delete',receipt_id:receipt,reason:'Wrong photo'},'https://other.test')).status).toBe(403);
    m.rpc.mockResolvedValue({error:{code:'42501',message:'Receipt outside your permitted branch'}});expect((await post({action:'delete',receipt_id:receipt,reason:'Wrong photo'})).status).toBe(403);
});
it('checks saved source evidence and queues a background refresh without trusting browser evidence', async () => {
    m.rpc.mockResolvedValue({ data: { allowed: false, blockers: ['facebook_stage_unavailable'] } });
    const r = await post({ action: 'check', contact_id: receipt, seller_id: worker, receipt_kind: 'closed', facebook: { stage: 'qualified' } });
    expect(r.status).toBe(200); expect((await r.json()).allowed).toBe(false);
    expect(m.rpc).toHaveBeenCalledWith('veo_request_source_refresh', { p_actor: worker, p_contact: receipt });
    expect(m.rpc).toHaveBeenCalledWith('veo_receipt_requirements', { p_actor: worker, p_contact: receipt, p_seller: worker, p_kind: 'closed', p_order: null, p_fresh: true });
    expect(m.storage.from).not.toHaveBeenCalled();
});
it('rejects an ineligible multipart submit before reserving storage or saving a receipt', async () => {
    m.rpc.mockImplementation(async name => ({ data: name === 'veo_receipt_requirements' ? { allowed: false, blockers: ['facebook_matching_order_required', 'verify_full_payment'] } : {} }));
    const form = new FormData();
    Object.entries({ contact_id: receipt, seller_id: worker, request_id: receipt, receipt_kind: 'done', deal_mode: 'new' }).forEach(([k, v]) => form.set(k, v));
    form.set('photo', new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }), 'receipt.jpg');
    const r = await POST(new NextRequest('https://veo.test/api/workspace/receipts', { method: 'POST', headers: { Origin: 'https://veo.test' }, body: form }));
    expect(r.status).toBe(422); expect((await r.json()).error).toContain('Receipt not submitted');
    expect(m.rpc).toHaveBeenCalledWith('veo_request_source_refresh', { p_actor: worker, p_contact: receipt });
    expect(m.from).not.toHaveBeenCalled(); expect(m.storage.from).not.toHaveBeenCalled(); expect(m.rpc.mock.calls.some(([name]) => name === 'veo_receipt_save')).toBe(false);
});
it('rejects a Closed Deal without its created order before uploading a photo', async () => {
    const form = new FormData();
    Object.entries({ contact_id: receipt, seller_id: worker, request_id: receipt, receipt_kind: 'closed', deal_mode: 'new' }).forEach(([key, value]) => form.set(key, value));
    form.set('photo', new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }), 'receipt.jpg');
    const response = await POST(new NextRequest('https://veo.test/api/workspace/receipts', { method: 'POST', headers: { Origin: 'https://veo.test' }, body: form }));
    expect(response.status).toBe(400);expect((await response.json()).error).toContain('Create and link the order');
    expect(m.storage.from).not.toHaveBeenCalled();expect(m.from).not.toHaveBeenCalled();expect(m.rpc).not.toHaveBeenCalled();
});
it('rechecks saved evidence after authorizing a receipt and queues refresh separately', async () => {
    m.rpc.mockImplementation(async name => ({ data: name === 'veo_receipt_access' ? { contact_id: receipt, seller_id: worker, receipt_kind: 'done', order_id: worker } : { allowed: false, blockers: ['verify_full_payment'] } }));
    expect((await post({ action: 'recheck', receipt_id: receipt })).status).toBe(422);
    expect(m.rpc).toHaveBeenCalledWith('veo_request_source_refresh', { p_actor: worker, p_contact: receipt }); expect(m.rpc.mock.calls.some(([name]) => name === 'veo_receipt_recheck')).toBe(false);
});

function uploadForm() {
    const form = new FormData();
    Object.entries({ contact_id: receipt, seller_id: worker, request_id: receipt, receipt_kind: 'done', deal_mode: 'new', order_id: worker }).forEach(([k, v]) => form.set(k, v));
    form.set('photo', new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }), 'receipt.jpg');
    return new NextRequest('https://veo.test/api/workspace/receipts', { method: 'POST', headers: { Origin: 'https://veo.test' }, body: form });
}
function savingDatabase(saveResult: any, existing: any = null) {
    let path = '';
    const remove = vi.fn(async () => ({ data: [] }));
    m.storage.from.mockReturnValue({ upload: vi.fn(async () => ({ data: {} })), remove });
    m.from.mockImplementation((table: string) => {
        const filters: Record<string, string> = {};
        const q: any = { select: () => q, eq: (key: string, value: string) => { filters[key] = value; return q; }, update: () => q, insert: async (data: any) => { path = data.object_path; return { data: {} }; }, maybeSingle: async () => {
            const row = typeof existing === 'function' ? existing(path) : existing;
            return { data: filters.object_path && row?.object_path !== filters.object_path ? null : row };
        }, then: (resolve: any) => resolve({ data: {} }) };
        return q;
    });
    m.rpc.mockImplementation(async name => {
        if (name === 'veo_receipt_requirements') return { data: { allowed: true, blockers: [] } };
        if (name === 'veo_receipt_save') { if (saveResult instanceof Error) throw saveResult; return saveResult; }
        if (name === 'veo_receipt_access') return { data: typeof existing === 'function' ? existing(path) : existing };
        return { data: {} };
    });
    return { remove, path: () => path };
}
it('never recovers a different client receipt when a request ID collides', async () => {
    const saved = savingDatabase({ error: { code: '23505', message: 'Request ID already used' } }, { id: receipt, contact_id: worker, seller_id: worker, receipt_kind: 'done', object_path: 'another-photo' });
    const r = await POST(uploadForm()); expect(r.status).toBe(409); expect((await r.json()).saved).toBeUndefined();
    expect(saved.remove).toHaveBeenCalledWith([saved.path()]); expect(m.rpc.mock.calls.some(([name]) => name === 'veo_receipt_access')).toBe(false);
});
it('keeps the private photo when a save outcome is uncertain and not visible yet', async () => {
    const saved = savingDatabase(Error('Response lost after save request'));
    const r = await POST(uploadForm()); expect(r.status).toBe(503); expect(saved.remove).not.toHaveBeenCalled();
});
it('recovers an acknowledged matching save without deleting its photo', async () => {
    const saved = savingDatabase(Error('Response lost'), (path: string) => ({ id: receipt, contact_id: receipt, seller_id: worker, receipt_kind: 'done', object_path: path }));
    const r = await POST(uploadForm()); expect(r.status).toBe(200); expect((await r.json()).saved.id).toBe(receipt); expect(saved.remove).not.toHaveBeenCalled();
});
it('recovers a concurrent matching retry and removes only the unused second upload', async () => {
    const saved = savingDatabase({ error: { code: '23505', message: 'Request already committed' } }, { id: receipt, contact_id: receipt, seller_id: worker, receipt_kind: 'done', object_path: 'first-upload' });
    const r = await POST(uploadForm()); expect(r.status).toBe(200); expect((await r.json()).saved.duplicate).toBe(true); expect(saved.remove).toHaveBeenCalledWith([saved.path()]);
});
it('never removes a referenced photo when a repeated save response reports a duplicate', async () => {
    const saved = savingDatabase({ data: { id: receipt, duplicate: true } }, (path: string) => ({ id: receipt, contact_id: receipt, seller_id: worker, receipt_kind: 'done', object_path: path }));
    const r = await POST(uploadForm()); expect(r.status).toBe(200); expect(saved.remove).not.toHaveBeenCalled();
});
it('saves eligible evidence only after the fresh check and returns the committed queue result', async () => {
    const saved = savingDatabase({ data: { id: receipt, duplicate: false, holds: [], delivery_status: 'queued' } });
    const r = await POST(uploadForm()); expect(r.status).toBe(202); expect((await r.json()).saved.delivery_status).toBe('queued');
    expect(m.rpc.mock.calls.some(([name]) => name === 'veo_request_source_refresh')).toBe(true); expect(saved.remove).not.toHaveBeenCalled();
});
