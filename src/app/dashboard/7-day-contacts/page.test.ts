import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetch: vi.fn(), role: 'member', visibility: new Map<string, () => void>() }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'worker', role: m.role } } }) }));
vi.mock('@/lib/supabase', () => ({ getSupabaseClient: () => null }));
import Page from './page';
let view: ReactTestRenderer;
beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); m.role = 'member'; m.visibility.clear();
    vi.stubGlobal('window', { location: { search: '' }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { hidden: false, addEventListener: (name: string, callback: () => void) => m.visibility.set(name, callback), removeEventListener: (name: string) => m.visibility.delete(name) });
    vi.stubGlobal('fetch', m.fetch);
    m.fetch.mockImplementation(async (path: string) => {
        if (path === '/api/pages') return Response.json({ pages: [{ id: 'page', name: 'Assigned Page' }] });
        if (path.startsWith('/api/tags')) { const page = Number(new URL(path, 'https://veo.test').searchParams.get('page')); return Response.json({ items: Array.from({ length: page === 1 ? 1000 : 1 }, (_, index) => ({ id: 'tag-' + ((page - 1) * 1000 + index), name: 'Tag ' + ((page - 1) * 1000 + index) })), total: 1001 }); }
        if (path.includes('follow-ups')) return Response.json({ jobs: [] });
        return Response.json({ items: [], total: 0 });
    });
});
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render() { await act(async () => { view = create(createElement(Page)); }); }
const contactReads = () => m.fetch.mock.calls.filter(([path]) => path.includes('/contacts?')).length;
it('keeps tag filters complete and skips Owner-only follow-up requests for staff', async () => {
    await render(); expect(JSON.stringify(view.toJSON())).toContain('Tag 1000');
    expect(m.fetch.mock.calls.filter(([path]) => path.startsWith('/api/tags'))).toHaveLength(2);
    expect(m.fetch.mock.calls.some(([path]) => path.includes('follow-ups'))).toBe(false);
});
it('pauses hidden-tab refresh and updates when the current tab becomes visible', async () => {
    await render(); const before = contactReads(); (document as any).hidden = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); }); expect(contactReads()).toBe(before);
    (document as any).hidden = false; await act(async () => m.visibility.get('visibilitychange')?.()); expect(contactReads()).toBe(before + 1);
});
it('shows unavailable tag filters explicitly instead of presenting a partial successful list', async () => {
    const normal = m.fetch.getMockImplementation()!;
    m.fetch.mockImplementation(async path => path.startsWith('/api/tags') && path.includes('page=2') ? Response.json({ error: 'unavailable' }, { status: 503 }) : normal(path));
    await render(); expect(JSON.stringify(view.toJSON())).toContain('Retry tag filters'); expect(JSON.stringify(view.toJSON())).not.toContain('Tag 999');
});
