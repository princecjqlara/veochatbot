import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } }));
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
