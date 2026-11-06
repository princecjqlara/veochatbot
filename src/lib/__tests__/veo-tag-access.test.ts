import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ ids: vi.fn() }));
vi.mock('../page-access', () => ({ getUserPageIds: m.ids }));
import { workspaceManualTags, workspaceTagAllowed, workspaceTagList } from '../veo-tag-access';
beforeEach(() => { vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); m.ids.mockResolvedValue(['veo']); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
function database(tags: any[], shares: any[] = []) {
    return { from: (table: string) => { const q: any = { select: () => q, order: () => q, range: () => q, in: () => q, then: (done: any) => done({ data: table === 'tags' ? tags : shares, error: null }) }; return q; } };
}
it('uses current VEO grants for tag ownership and respects Page revocation', async () => {
    expect(await workspaceTagAllowed('head', { owner_type: 'page', owner_id: 'veo' })).toBe(true);
    expect(await workspaceTagAllowed('head', { owner_type: 'page', owner_id: 'suno' })).toBe(false);
    m.ids.mockResolvedValue([]); expect(await workspaceTagAllowed('head', { owner_type: 'page', owner_id: 'veo' })).toBe(false);
});
it('lists only visible manual/shared tags and keeps stage history separate', async () => {
    const db = database([{ id: 'manual', owner_type: 'page', owner_id: 'veo', page_id: 'veo', name: 'Follow up' }, { id: 'history', owner_type: 'page', owner_id: 'veo', page_id: 'veo', name: 'History Converted', system_key: 'stage_history:converted' }, { id: 'private', owner_type: 'user', owner_id: 'other', page_id: 'veo', is_shared: false, name: 'Private' }, { id: 'restricted', owner_type: 'user', owner_id: 'other', page_id: 'veo', is_shared: true, name: 'Restricted' }], [{ tag_id: 'restricted', shared_with_user_id: 'someone-else' }]);
    const r = await workspaceTagList(new NextRequest('https://veo.test/api/tags?kind=manual&pageId=veo'), 'head', db), body = await r.json();
    expect(body.items.map((t: any) => t.id)).toEqual(['manual']); expect(body.kind_counts.history).toBe(1);
});
it('rejects unsupported Page filters without reading any tag data', async () => {
    const db = { from: vi.fn() }; expect((await workspaceTagList(new NextRequest('https://veo.test/api/tags?pageId=suno'), 'head', db)).status).toBe(403); expect(db.from).not.toHaveBeenCalled();
});
it('does not permit manual editing of system tags, another Page, or unavailable private tags', async () => {
    for (const tag of [{ id: 'tag', owner_type: 'page', owner_id: 'veo', system_key: 'stage_history:converted' }, { id: 'tag', owner_type: 'page', owner_id: 'suno' }, { id: 'tag', owner_type: 'user', owner_id: 'other', page_id: 'veo', is_shared: false }]) expect(await workspaceManualTags(database([tag]), 'head', 'veo', ['tag'])).toBe(false);
    expect(await workspaceManualTags(database([{ id: 'tag', owner_type: 'page', owner_id: 'veo' }]), 'head', 'veo', ['tag'])).toBe(true);
});
