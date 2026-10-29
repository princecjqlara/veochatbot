import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), ids: vi.fn(), db: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/page-access', () => ({ getUserPageIds: m.ids }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: m.db }));
import { GET } from './route';
describe('ad quality authorization and complete reports', () => {
    beforeEach(() => {
        vi.clearAllMocks(); m.session.mockResolvedValue({ user: { id: 'owner' } }); m.ids.mockResolvedValue(['page-a', 'page-b']);
        m.from.mockReturnValue({ select: () => ({ in: async (_: string, ids: string[]) => ({ data: ids.map(id => ({ id, name: id, fb_page_id: '123' })), error: null }) }) });
        m.rpc.mockResolvedValue({ data: { inquiries: 1200, rows: [{ ad_id: null, inquiries: 1200, not_qualified: 17 }] }, error: null }); m.db.mockReturnValue({ from: m.from, rpc: m.rpc });
    });
    it('rejects a Page outside membership before querying any lead data', async () => {
        const res = await GET(new NextRequest('https://example.com/api/ad-quality?pageId=other&range=all'));
        expect(res.status).toBe(403); expect(m.db).not.toHaveBeenCalled();
    });
    it('returns database aggregates without the 1000-row client pagination trap', async () => {
        const res = await GET(new NextRequest('https://example.com/api/ad-quality?range=all')), b = await res.json();
        expect(res.status).toBe(200); expect(b.pages).toHaveLength(2); expect(b.pages[0].inquiries).toBe(1200);
        expect(b.pages[0].rows[0].lead_quality).toMatchObject({poor:17,poor_rate:17/1200});
        expect(m.rpc).toHaveBeenCalledWith('get_ad_lead_quality', expect.objectContaining({ p_from: null, p_page_id: 'page-a' }));
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
    it('rejects unauthenticated and invalid-date requests', async () => {
        expect((await GET(new NextRequest('https://example.com/api/ad-quality?range=custom&from=bad&to=bad'))).status).toBe(400);
        m.session.mockResolvedValue(null); expect((await GET(new NextRequest('https://example.com/api/ad-quality'))).status).toBe(401);
    });
});
