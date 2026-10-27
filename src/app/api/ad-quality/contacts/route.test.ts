import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), db: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: m.access }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: m.db }));
import { GET } from './route';
describe('ad contact drilldown', () => {
    beforeEach(() => { vi.clearAllMocks(); m.session.mockResolvedValue({ user: { id: 'owner' } }); m.access.mockResolvedValue(true); m.rpc.mockResolvedValue({ data: { total: 2, contacts: [] }, error: null }); m.db.mockReturnValue({ rpc: m.rpc }); });
    it('checks Page membership before exposing names or identifiers', async () => {
        m.access.mockResolvedValue(false); expect((await GET(new NextRequest('https://example.com/api/ad-quality/contacts?pageId=other&range=all'))).status).toBe(403); expect(m.db).not.toHaveBeenCalled();
    });
    it('preserves inquiry-cohort, source-ad, stage and pagination filters', async () => {
        const r = await GET(new NextRequest('https://example.com/api/ad-quality/contacts?pageId=p&range=all&adId=120999999999999999&stage=not_qualified&offset=25'));
        expect(r.status).toBe(200); expect(m.rpc).toHaveBeenCalledWith('get_ad_lead_contacts_v2', expect.objectContaining({ p_page_id: 'p', p_from: null, p_ad_id: '120999999999999999', p_stage: 'not_qualified', p_bot:'all', p_offset: 25, p_limit: 25 }));
    });
    it('rejects invalid stage, ad ID and pagination', async () => {
        for (const q of ['stage=made_up', 'adId=1.2', 'offset=-1']) expect((await GET(new NextRequest('https://example.com/api/ad-quality/contacts?pageId=p&range=all&' + q))).status).toBe(400);
    });
});
