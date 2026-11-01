import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), db: vi.fn(), sources: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.session }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: mocks.access }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
vi.mock('@/lib/contact-profile-sources', () => ({ getContactSources: mocks.sources }));
import { GET } from './route';
const scope = { params: Promise.resolve({ pageId: 'page', contactId: 'contact' }) };
const request = (query = '') => new NextRequest('https://app.test/api/pages/page/contacts/contact/profile/sources' + query);
beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue({ user: { id: 'member' } }); mocks.access.mockResolvedValue(true); mocks.db.mockReturnValue({}); mocks.sources.mockResolvedValue({ origin: null, touches: [] }); });
describe('private contact ad-source access', () => {
    it('requires authentication and Page membership before reading referral codes or creatives', async () => {
        mocks.session.mockResolvedValue(null); expect((await GET(request(), scope)).status).toBe(401);
        mocks.session.mockResolvedValue({ user: { id: 'member' } }); mocks.access.mockResolvedValue(false);
        expect((await GET(request(), scope)).status).toBe(403); expect(mocks.sources).not.toHaveBeenCalled(); expect(mocks.db).not.toHaveBeenCalled();
    });
    it('passes the authorized Page/contact and requested source page, returning uncached private data', async () => {
        const response = await GET(request('?page=2&eventKey=event-123'), scope);
        expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
        expect(mocks.sources).toHaveBeenCalledWith({}, 'page', 'contact', { page: 2, eventKey: 'event-123' });
    });
    it('rejects invalid source references and hides contacts outside the Page', async () => {
        expect((await GET(request('?eventKey=bad%22reference'), scope)).status).toBe(400); expect(mocks.sources).not.toHaveBeenCalled();
        mocks.sources.mockResolvedValue(null); expect((await GET(request(), scope)).status).toBe(404);
    });
});
