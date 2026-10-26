import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), db: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: m.access }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: m.db }));
import { POST } from './route';
const req = (origin = 'https://example.com', body: unknown = { pageId: 'p', adIds: ['123'] }) => new NextRequest('https://example.com/api/ad-quality/resolve', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
describe('ad metadata access', () => {
    beforeEach(() => { vi.clearAllMocks(); m.session.mockResolvedValue({ user: { id: 'owner' } }); m.access.mockResolvedValue(true); });
    it('rejects cross-origin metadata triggers and Pages outside membership', async () => {
        expect((await POST(req('https://other.example'))).status).toBe(403); m.access.mockResolvedValue(false); expect((await POST(req())).status).toBe(403); expect(m.db).not.toHaveBeenCalled();
    });
    it('rejects numeric IDs, excessive requests and unauthenticated requests', async () => {
        expect((await POST(req(undefined, { pageId: 'p', adIds: [123] }))).status).toBe(400);
        expect((await POST(req(undefined, { pageId: 'p', adIds: Array(21).fill('123') }))).status).toBe(400);
        m.session.mockResolvedValue(null); expect((await POST(req())).status).toBe(401);
    });
});
