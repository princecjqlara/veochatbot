import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), rpc: vi.fn(), from: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/veo-jaucian', () => ({ jaucianRead: m.read }));
import { GET, POST } from './route';
const request = (origin = 'https://veo.test') => new NextRequest('https://veo.test/api/workspace/profile/telegram-link', { method: 'POST', headers: { origin } });
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
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
function relinkRequest(body: any = { code: 'a'.repeat(48), relink: true, expected_telegram_user_id: '42', user_id: 'attacker' }) {
    return new NextRequest('https://veo.test/api/workspace/profile/telegram-link', { method: 'POST', headers: { Origin: 'https://veo.test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
function proof(tenant = 'tenant') {
    vi.stubEnv('VEO_APPROVED_TELEGRAM_CHAT_IDS', '-123'); m.session.mockResolvedValue({ user: { id: 'self' } });
    m.from.mockImplementation((table: string) => { const q: any = { select: () => q, eq: () => q, gt: () => q, is: () => q, maybeSingle: async () => ({ data: table === 'veo_accounts' ? { tenant_id: 'tenant' } : { tenant_id: tenant, telegram_user_id: 84, chat_id: -123 } }) }; return q; });
    m.read.mockResolvedValue({ verified: true, user_id: 84, chat_id: -123 }); m.rpc.mockResolvedValue({ data: { linked: true, telegram_user_id: '84' } });
}
it('verifies fresh Telegram membership and replaces only the authenticated user’s expected link', async () => {
    proof(); const r = await POST(relinkRequest()); expect(r.status).toBe(200); expect((await r.json()).telegram_user_id).toBe('84');
    expect(m.read).toHaveBeenCalledWith('tenant', { resource: 'identity', chat_id: '-123', user_id: '84' });
    expect(m.rpc).toHaveBeenCalledWith('veo_relink_telegram_pairing', { p_actor: 'self', p_hash: createHash('sha256').update('a'.repeat(48)).digest('hex'), p_expected: '42' });
});
it.each(['mismatched', 'unavailable', 'foreign', 'unapproved'])('cannot change a Telegram link with %s membership proof', async kind => {
    proof(kind === 'foreign' ? 'other' : 'tenant');
    if (kind === 'mismatched') m.read.mockResolvedValue({ verified: true, user_id: 99, chat_id: -123 });
    if (kind === 'unavailable') m.read.mockRejectedValue(new Error('offline'));
    if (kind === 'unapproved') vi.stubEnv('VEO_APPROVED_TELEGRAM_CHAT_IDS', '-999');
    expect((await POST(relinkRequest())).status).not.toBe(200); expect(m.rpc).not.toHaveBeenCalled();
});
it.each(['23505', '40001'])('keeps the existing link when the database reports %s conflict', async code => {
    proof(); m.rpc.mockResolvedValue({ error: { code } }); expect((await POST(relinkRequest())).status).toBe(409);
});
it('rejects malformed replacement requests before reading identity proof', async () => {
    proof(); for (const body of [null, [], { relink: 'yes' }, { relink: true, code: 'a'.repeat(48) }]) expect((await POST(relinkRequest(body))).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled(); expect(m.read).not.toHaveBeenCalled();
});
