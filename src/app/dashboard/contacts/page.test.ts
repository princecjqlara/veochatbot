import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetch: vi.fn(), channel: vi.fn(), subscribe: vi.fn(), remove: vi.fn(), listener: undefined as undefined | ((status: string) => void), visibility: new Map<string, any>() }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'owner' } } }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
vi.mock('@/components/Modal', () => ({ default: () => null }));
vi.mock('@/lib/supabase', () => ({ getSupabaseClient: () => ({ channel: m.channel, removeChannel: m.remove }) }));
import Page from './page';
let view: ReactTestRenderer;
beforeEach(() => {
    vi.clearAllMocks();vi.useFakeTimers();m.visibility.clear();
    vi.stubGlobal('window', { location: { search: '' }, localStorage: { getItem: () => null }, setTimeout, clearTimeout });
    vi.stubGlobal('document', { hidden: false, addEventListener: (name: string, cb: any) => m.visibility.set(name, cb), removeEventListener: (name: string) => m.visibility.delete(name) });
    const channel: any = { on: () => channel, subscribe: m.subscribe };m.channel.mockReturnValue(channel);m.subscribe.mockImplementation((cb: any) => { m.listener = cb;cb('SUBSCRIBED');return channel; });m.remove.mockResolvedValue(undefined);
    m.fetch.mockImplementation(async (url: string) => {
        if (url === '/api/pages') return Response.json({ pages: [{ id: 'page', name: 'Page' }] });
        if (url.startsWith('/api/tags?')) return Response.json({ items: [{ id: 'tag', name: 'Tag', owner_type: 'page' }], total: 1 });
        if (url.includes('/contacts?')) return Response.json({ items: [], total: 0 });
        return Response.json({ templates: [], success: true });
    });vi.stubGlobal('fetch', m.fetch);
});
afterEach(async () => { if (view) await act(async () => view.unmount());vi.useRealTimers();vi.unstubAllGlobals(); });
const reads = () => m.fetch.mock.calls.filter(([url]) => String(url).includes('/contacts?'));
async function render() { await act(async () => { view = create(createElement(Page)); });await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
it('coalesces typing into one search without reloading tags or recreating realtime subscriptions', async () => {
    await render();expect(reads()).toHaveLength(1);
    const search = view.root.findByProps({ placeholder: 'SEARCH NAMES...' });
    for (const value of ['a', 'ab', 'abc']) await act(async () => search.props.onChange({ target: { value } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });expect(reads()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });expect(reads()).toHaveLength(2);expect(reads().at(-1)?.[0]).toContain('search=abc');
    expect(m.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/tags?'))).toHaveLength(1);expect(m.channel).toHaveBeenCalledOnce();
});
it('skips hidden-tab polling and refreshes the current filters when returning', async () => {
    await render();await act(async () => m.listener?.('CHANNEL_ERROR'));
    const before = reads().length;(document as any).hidden = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });expect(reads()).toHaveLength(before);
    (document as any).hidden = false;await act(async () => m.visibility.get('visibilitychange')?.());expect(reads()).toHaveLength(before + 1);
});
it('cancels a superseded search and ignores its late response', async () => {
    await render();const normal = m.fetch.getMockImplementation()!;let finish!: (response: Response) => void, oldSignal: AbortSignal | undefined;
    m.fetch.mockImplementation((url, init?: any) => String(url).includes('search=old') ? (oldSignal = init.signal,new Promise<Response>(resolve => { finish = resolve; })) : normal(url));
    const search = view.root.findByProps({ placeholder: 'SEARCH NAMES...' });
    await act(async () => search.props.onChange({ target: { value: 'old' } }));await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await act(async () => search.props.onChange({ target: { value: 'current' } }));expect(oldSignal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });await act(async () => finish(Response.json({ items: [{ id: 'obsolete', name: 'Obsolete contact row' }], total: 1 })));
    expect(JSON.stringify(view.toJSON())).not.toContain('Obsolete contact row');
});
