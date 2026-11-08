import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), rpc: vi.fn(), read: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => m }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, uuid: (v: any) => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v) }));
vi.mock('@/lib/veo-jaucian', () => ({ jaucianRead: m.read }));
import { GET, POST } from './route';
const actor = '00000000-0000-4000-8000-000000000001', worker = '00000000-0000-4000-8000-000000000002', team = '00000000-0000-4000-8000-000000000003';
const post = (body: any, origin = 'https://veo.test') => POST(new NextRequest('https://veo.test/api/workspace/telegram-groups', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body) }));
beforeEach(() => {
    m.session.mockResolvedValue({ user: { id: actor } });m.scope.mockResolvedValue({ role: 'manager', user_id: actor, tenant_id: 'tenant', launch_at: 'launched' });
    m.rpc.mockImplementation(async name => ({ data: name === 'veo_telegram_groups_page' ? { teams: [{ id: team }], accounts: [{ user_id: worker }] } : true }));
    m.read.mockResolvedValue({ groups: [{ chat_id: -123 }] });
});
afterEach(() => { vi.resetAllMocks(); });
it('authenticates scoped reads and never trusts browser actor or tenant identifiers', async () => {
    m.session.mockResolvedValueOnce(null);expect((await GET(new NextRequest('https://veo.test/api/workspace/telegram-groups'))).status).toBe(401);
    const r = await GET(new NextRequest('https://veo.test/api/workspace/telegram-groups?actor=foreign'));
    expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(m.rpc).toHaveBeenCalledWith('veo_telegram_groups_page', { p_actor: actor });
});
it('blocks cross-origin writes, members and non-Head bot-directory refreshes', async () => {
    expect((await post({ action: 'refresh' }, 'https://foreign.test')).status).toBe(403);
    expect((await post({ action: 'refresh' })).status).toBe(403);
    m.scope.mockResolvedValue({ role: 'member', user_id: actor, launch_at: 'launched' });expect((await post({ action: 'group' })).status).toBe(403);expect(m.read).not.toHaveBeenCalled();
});
it('verifies current human membership in the chosen additional group before saving, with branch checks first', async () => {
    m.read.mockImplementation(async (_tenant, params) => params?.resource === 'identity' ? { verified: true, chat_id: -123, user_id: 42 } : { groups: [{ chat_id: -123 }] });
    expect((await post({ action: 'membership', user_id: worker, chat_id: -123, telegram_user_id: 42, actor: worker })).status).toBe(200);
    expect(m.read).toHaveBeenCalledWith('tenant', { resource: 'identity', chat_id: '-123', user_id: '42' });
    expect(m.rpc).toHaveBeenCalledWith('veo_telegram_group_action', expect.objectContaining({ p_actor: actor, p_action: 'membership' }));
    m.read.mockClear();expect((await post({ action: 'membership', user_id: team, chat_id: -123, telegram_user_id: 42 })).status).toBe(403);expect(m.read).not.toHaveBeenCalled();
});
it('does not save a stale, unapproved group or a mismatched Telegram identity', async () => {
    m.read.mockResolvedValueOnce({ groups: [] });expect((await post({ action: 'group', team_id: team, chat_id: -123, page_ids: [actor] })).status).toBe(400);
    m.read.mockImplementation(async (_tenant, params) => params ? { verified: true, user_id: 99, chat_id: -123 } : { groups: [{ chat_id: -123 }] });
    expect((await post({ action: 'membership', user_id: worker, chat_id: -123, telegram_user_id: 42 })).status).toBe(400);
    expect(m.rpc.mock.calls.filter(([name]) => name === 'veo_telegram_group_action')).toHaveLength(0);
});
