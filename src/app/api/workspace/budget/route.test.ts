import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), read: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, philippineDate: () => '2026-11-06' }));
vi.mock('@/lib/veo-budget', () => ({ pageBudgetData: m.read, savePageBudget: m.save }));
import { GET, POST } from './route';
beforeEach(() => { m.session.mockResolvedValue({ user: { id: 'leader' } }); m.scope.mockResolvedValue({ user_id: 'leader', role: 'team_leader', launch_at: '2026-11-05' }); m.read.mockResolvedValue({ plans: [] }); m.save.mockResolvedValue({ saved: true }); });
afterEach(() => { vi.clearAllMocks(); });
it.each(['member', 'manager'])('blocks %s from reading or changing Page ad budgets', async role => {
    m.scope.mockResolvedValue({ user_id: 'leader', role, launch_at: '2026-11-05' });
    expect((await GET(new NextRequest('https://veo.test/api/workspace/budget'))).status).toBe(403);
    expect((await POST(new NextRequest('https://veo.test/api/workspace/budget', { method: 'POST', headers: { Origin: 'https://veo.test' }, body: JSON.stringify({ action: 'calculate' }) }))).status).toBe(403);
    expect(m.read).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled();
});
it('allows scoped Team Leader planning and rejects cross-origin writes', async () => {
    expect((await GET(new NextRequest('https://veo.test/api/workspace/budget?date=2026-11-07'))).status).toBe(200);
    expect(m.read).toHaveBeenCalledWith('leader', '2026-11-07');
    const body = { action: 'page_weight', user_id: 'worker', page_id: 'page', weight: 1 };
    expect((await POST(new NextRequest('https://veo.test/api/workspace/budget', { method: 'POST', body: JSON.stringify(body) }))).status).toBe(403);
    expect(m.save).not.toHaveBeenCalled();
    expect((await POST(new NextRequest('https://veo.test/api/workspace/budget', { method: 'POST', headers: { Origin: 'https://veo.test' }, body: JSON.stringify(body) }))).status).toBe(200);
    expect(m.save).toHaveBeenCalledWith('leader', body);
});
