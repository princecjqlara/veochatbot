import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
import { GET, POST } from './route';
const request = (origin = 'https://veo.test') => new NextRequest('https://veo.test/api/workspace/profile/telegram-link', { method: 'POST', headers: { origin } });
afterEach(() => { vi.resetAllMocks(); });
it('creates a short-lived command for the authenticated account and stores only its hash', async () => {
    m.session.mockResolvedValue({ user: { id: 'self' } });m.rpc.mockResolvedValue({ data: { expires_at: 'later' } });
    const r = await POST(request()), b = await r.json();
    expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');
    const code = b.command.split(' ')[1];expect(code).toMatch(/^[a-f0-9]{48}$/);
    expect(m.rpc).toHaveBeenCalledWith('veo_create_telegram_link', { p_actor: 'self', p_hash: createHash('sha256').update(code).digest('hex') });
});
it('rejects cross-origin or unauthenticated code creation and status reads', async () => {
    expect((await POST(request('https://foreign.test'))).status).toBe(403);
    m.session.mockResolvedValue(null);expect((await POST(request())).status).toBe(401);expect((await GET(request())).status).toBe(401);expect(m.rpc).not.toHaveBeenCalled();
});
