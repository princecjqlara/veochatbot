import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), directory: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope }));
vi.mock('@/lib/veo-jaucian', () => ({ veoDirectory: m.directory, jaucianRead: m.read }));
import { GET } from './route';
afterEach(() => { vi.resetAllMocks(); });
it('requires the launched Owner before reading either database directory', async () => {
    const request = new NextRequest('https://veo.example/api/workspace/jaucian');
    m.session.mockResolvedValue(null);
    expect((await GET(request)).status).toBe(401);
    m.session.mockResolvedValue({ user: { id: 'user' } });
    for (const role of ['member', 'manager', 'team_leader']) {
        m.scope.mockResolvedValue({ role, tenant_id: 'tenant', launch_at: 'launched' });
        expect((await GET(request)).status).toBe(403);
    }
    expect(m.read).not.toHaveBeenCalled(); expect(m.directory).not.toHaveBeenCalled();
    m.scope.mockResolvedValue({ role: 'owner', tenant_id: 'tenant', launch_at: 'launched' });
    m.read.mockResolvedValue({ groups: [] }); m.directory.mockResolvedValue({ teams: [] });
    const response = await GET(request);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(m.read).toHaveBeenCalledWith('tenant'); expect(m.directory).toHaveBeenCalledWith('tenant');
});
