import { afterEach, expect, it, vi } from 'vitest';
const fetchNotices = vi.hoisted(() => vi.fn());
vi.mock('../veo-business-orders', () => ({ fetchBusinessOrderNotices: fetchNotices }));
import { refreshReceiptFacebook, refreshSubmissionFacebook } from '../veo-facebook-check';
afterEach(() => { vi.clearAllMocks(); });
function database() {
    const db: any = { rpc: vi.fn(async (name: string) => ({ data: name === 'veo_facebook_check_context' ? { page_id: 'page', psid: 'client', launch_at: '2026-11-05' } : name === 'veo_submission_facebook_context' ? { actor_id: 'worker', contact_id: 'client' } : { complete: true } })), from: vi.fn() };
    db.from.mockReturnValue({ select: () => ({ eq: () => ({ single: async () => ({ data: { fb_page_id: 'fb-page', access_token: 'private-token' } }) }) }) });
    return db;
}
it('rechecks access before fetching and stores only server parsed evidence under the session actor', async () => {
    const db = database(), scan = { orders: [], stage: { stage: 'qualified', message_id: 'id', occurred_at: '2026-11-06' }, complete: true, pages_checked: 1 };
    fetchNotices.mockResolvedValue(scan); await refreshReceiptFacebook(db, 'worker', 'client');
    expect(db.rpc).toHaveBeenNthCalledWith(1, 'veo_facebook_check_context', { p_actor: 'worker', p_contact: 'client' });
    expect(db.rpc).toHaveBeenLastCalledWith('veo_record_facebook_check', expect.objectContaining({ p_actor: 'worker', p_contact: 'client', p_scan: scan }));
    expect(JSON.stringify(db.rpc.mock.calls)).not.toContain('private-token');
    db.rpc.mockResolvedValueOnce({ error: { code: '42501' } }); db.from.mockClear(); await expect(refreshReceiptFacebook(db, 'worker', 'other-client')).rejects.toThrow(/access/); expect(db.from).not.toHaveBeenCalled();
});
it('invalidates earlier success when Facebook is unavailable and does not allow stale delivery', async () => {
    const db = database(); fetchNotices.mockRejectedValue(Object.assign(Error('Timed out'), { name: 'TimeoutError' }));
    db.rpc.mockImplementation(async (name: string, args: any) => ({ data: name === 'veo_facebook_check_context' ? { page_id: 'page', psid: 'client', launch_at: '2026-11-05' } : name === 'veo_submission_facebook_context' ? { actor_id: 'worker', contact_id: 'client' } : args.p_scan }));
    await expect(refreshSubmissionFacebook(db, 'submission')).rejects.toThrow(/retry/);
    expect(db.rpc).toHaveBeenLastCalledWith('veo_record_facebook_check', expect.objectContaining({ p_scan: expect.objectContaining({ complete: false, stage: null, orders: [], error: 'Facebook check timed out. Retry shortly.' }) }));
});
it('never fetches a deleted, revoked or expired submission', async () => {
    const db = database(); db.rpc.mockResolvedValue({ data: null });
    expect(await refreshSubmissionFacebook(db, 'submission')).toBe(false); expect(fetchNotices).not.toHaveBeenCalled(); expect(db.from).not.toHaveBeenCalled();
});
