import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ guard: vi.fn(), read: vi.fn(), from: vi.fn(), session: vi.fn(), scope: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/veo-workspace', () => ({ workspaceScope: m.scope, uuid: (value: any) => typeof value === 'string' && value.length === 36 }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: m.from }) }));
vi.mock('@/lib/veo-contact-identity-sync', () => ({ readContactIdentityBatch: m.read }));
vi.mock('@/lib/veo-storage-health', () => ({ requireStorageForOptionalWork: m.guard }));
import { POST } from './route';
const page = '00000000-0000-4000-8000-000000000001';
const request = () => new NextRequest('https://veo.test/api/workspace/contacts/sync', { method: 'POST', headers: { Origin: 'https://veo.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ page_id: page }) });
beforeEach(() => { vi.clearAllMocks();m.session.mockResolvedValue({ user: { id: 'owner' } });m.scope.mockResolvedValue({ role: 'owner', page_ids: [page] }); });
it('does not read provider history or save a batch when storage is critical or monitoring is stale', async () => {
    m.guard.mockRejectedValueOnce(Object.assign(Error('Bulk processing paused for storage attention'), { status: 503, code: 'STORAGE_ATTENTION' }));
    const response = await POST(request());expect(response.status).toBe(503);expect((await response.json()).code).toBe('STORAGE_ATTENTION');expect(response.headers.get('Retry-After')).toBe('300');expect(m.from).not.toHaveBeenCalled();expect(m.read).not.toHaveBeenCalled();
});
it('checks actor and Page access before probing storage', async () => {
    m.scope.mockResolvedValueOnce({ role: 'member', page_ids: [page] });expect((await POST(request())).status).toBe(403);expect(m.guard).not.toHaveBeenCalled();
});
