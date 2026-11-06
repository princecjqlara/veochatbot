import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ rpc: vi.fn(), session: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ rpc: m.rpc }) }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
import { POST } from './route';
const request = (body: any, origin = 'https://veo.test') => new NextRequest('https://veo.test/api/workspace/profile', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
afterEach(() => { vi.clearAllMocks(); });
describe('self-reported Telegram profile', () => {
    it('saves the current account only and cannot turn a supplied username into a verified Telegram mapping', async () => {
        m.session.mockResolvedValue({ user: { id: 'worker' } }); m.rpc.mockResolvedValue({ data: { telegram_username: 'worker_name' } });
        expect((await POST(request({ username: '@Worker_Name', no_username: false, user_id: 'owner', telegram_user_id: 123 }))).status).toBe(200);
        expect(m.rpc).toHaveBeenCalledTimes(1);
        expect(m.rpc).toHaveBeenCalledWith('veo_save_telegram_profile', { p_actor: 'worker', p_username: '@Worker_Name', p_no_username: false });
    });
    it('rejects cross-origin and anonymous writes, and accepts an explicit no-username declaration', async () => {
        expect((await POST(request({ username: '@someone', no_username: false }, 'https://other.test'))).status).toBe(403);
        m.session.mockResolvedValue(null); expect((await POST(request({ username: '@someone', no_username: false }))).status).toBe(401);
        m.session.mockResolvedValue({ user: { id: 'worker' } }); m.rpc.mockResolvedValue({ data: { telegram_username: null } });
        expect((await POST(request({ username: '', no_username: true }))).status).toBe(200);
    });
});
