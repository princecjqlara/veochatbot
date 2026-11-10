import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), fetch: vi.fn(), imports: [] as Promise<any>[] }));
vi.mock('next/dynamic', () => ({ default: (loader: () => Promise<any>) => {
    let Component: any; const pending = loader().then(mod => { Component = mod.default; });m.imports.push(pending);
    return (props: any) => { if (!Component) throw pending;return createElement(Component, props); };
} }));
vi.mock('next/navigation', () => ({ useSearchParams: () => m.params, useRouter: () => ({ replace: m.replace }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => createElement('a', { href, ...props }, children) }));
import Page from './page';
let view: ReactTestRenderer;
function dashboard(role = 'member') {
    return { scope: { user_id: 'worker', role, launch_at: '2026-11-05T00:00:00Z' }, accounts: [{ id: 'worker', name: 'Worker', role: 'member' }],
        orders: [], teams: [], tomorrow: [], salary: [], submissions: [], sync: [], order_page: { total: 0 } };
}
beforeEach(async () => { await Promise.all(m.imports);vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal('fetch', m.fetch); });
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(role = 'member', params = 'view=dashboard') {
    m.params = new URLSearchParams(params);
    m.fetch.mockImplementation(async (url: string) => {
        const query = new URL(url, 'https://veo.test');
        if (query.pathname === '/api/pages') return new Response(JSON.stringify({ pages: [{ id: 'page-1', name: 'VEO One' }, { id: 'page-2', name: 'VEO Two' }] }));
        if (query.pathname === '/api/workspace/operations') return new Response(JSON.stringify({ summary: {}, orders: [], finance: { days: [] }, employees: [], page_rankings: [], order_page: { total: 0 }, client_assignments: [] }));
        if (query.pathname === '/api/workspace/budget') return new Response(JSON.stringify({ plans: [], saved: [], defaults: {} }));
        if (query.pathname === '/api/workspace/jaucian') return new Response(JSON.stringify({ workspace: { teams: [], accounts: [] }, jaucian: { groups: [], checked_at: '2026-11-09T00:00:00Z', veo_connection: { ok: true } } }));
        if (query.pathname === '/api/workspace/telegram-groups') return new Response(JSON.stringify({ scope: dashboard(role).scope, groups: [], teams: [], accounts: [], memberships: [], can_manage: role !== 'member' }));
        if (query.pathname === '/api/workspace/new-clients') return new Response(JSON.stringify(query.searchParams.has('context') ? { scope: dashboard(role).scope } : { items: [], roster: [], readiness: { ready: false }, total: 0 }));
        if (query.pathname === '/api/workspace/contacts') {
            const search = query.searchParams.get('search') || '';
            const items = !search || 'searchable client'.includes(search.toLowerCase()) ? [{ id: 'client', page_id: 'page-2', page_name: 'VEO Two', name: 'Searchable Client', psid: '123', pipeline_stage: 'new' }] : [];
            return new Response(JSON.stringify({ items, total: items.length }));
        }
        return new Response(JSON.stringify(dashboard(role)));
    });
    await act(async () => { view = create(createElement(Page)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}
describe('workspace contacts, unified deals and Owner separation', () => {
    it('displays API items as searchable contacts across all assigned pages even when no orders exist, and allows selecting a client', async () => {
        await render();
        expect(JSON.stringify(view.toJSON())).toContain('Searchable Client');
        expect(JSON.stringify(view.toJSON())).toContain('VEO Two');
        const search = view.root.findAllByType('input').find(i => i.props.placeholder?.startsWith('Search client'))!;
        await act(async () => search.props.onChange({ target: { value: 'searchable' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(m.fetch.mock.calls.some(([u]) => u.startsWith('/api/workspace/contacts?') && u.includes('search=searchable') && !u.includes('page_id='))).toBe(true);
        expect(JSON.stringify(view.toJSON())).toContain('Searchable Client');
        await act(async () => view.root.findAllByType('a').find(a => a.props.href === '#create-order')!.props.onClick());
        expect(view.root.findByProps({ href: '/dashboard/workspace?view=new_clients&contact_id=client' })).toBeTruthy();
    });
    it('has one Deals tab and a dropdown that requests Done or Closed milestones', async () => {
        await render('member', 'view=deals');
        const navigation = view.root.findByType('nav');
        expect(navigation.findAllByType('a').filter(a => a.props.href.includes('view=deals'))).toHaveLength(1);
        expect(navigation.findAllByType('a').some(a => /view=(closed|done)/.test(a.props.href))).toBe(false);
        const select = view.root.findAllByType('select').find(s => s.findAllByType('option').some(o => o.props.value === 'done'))!;
        await act(async () => select.props.onChange({ target: { value: 'done' } }));
        expect(m.replace).toHaveBeenCalledWith('/dashboard/workspace?view=deals&status=done');
        m.params = new URLSearchParams('view=deals&status=done');
        await act(async () => { view.update(createElement(Page)); });
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(m.fetch.mock.calls.some(([u]) => u.startsWith('/api/workspace/context?view=deals'))).toBe(true);
    });
    it('shows CJ a teams dashboard with management navigation and keeps individual seller forms separate', async () => {
        await render('owner', '');
        const text = JSON.stringify(view.toJSON());
        expect(text).toContain('Teams dashboard'); expect(text).toContain('Team results and tomorrow');
        expect(text).not.toContain('Create order'); expect(text).not.toContain('Record verified payment');
        const links = view.root.findByType('nav').findAllByType('a').map(a => a.props.href);
        expect(links).toContain('/dashboard/workspace?view=accounts');
        expect(links.some(h => /view=(clients|deals)/.test(h))).toBe(false);
        expect(links).toContain('/dashboard/workspace?view=salary');
        expect(links).toContain('/dashboard/workspace?view=new_clients');
    });
    it('opens New Clients with its lightweight scope instead of reading dashboard finances or a client history', async () => {
        await render('owner', 'view=new_clients&contact_id=client');
        expect(JSON.stringify(view.toJSON())).toContain('New clients');
        expect(m.fetch.mock.calls.some(([u]) => u.startsWith('/api/workspace/new-clients?'))).toBe(true);
        expect(m.fetch.mock.calls.some(([u]) => u === '/api/workspace/new-clients?context=1')).toBe(true);
        expect(m.fetch.mock.calls.some(([u]) => u.startsWith('/api/workspace?'))).toBe(false);
    });
    it('opens Telegram setup for the Head without fetching financial dashboards or contact history', async () => {
        await render('owner', 'view=telegram&contact_id=client');
        expect(JSON.stringify(view.toJSON())).toContain('Fetch teams and Pages from Jaucian');
        expect(m.fetch.mock.calls.some(([u]) => u === '/api/workspace/telegram-groups')).toBe(true);
        expect(m.fetch.mock.calls.some(([u]) => u.startsWith('/api/workspace?') || u.startsWith('/api/workspace/profile'))).toBe(false);
    });
    it('loads detailed team reports only after the owner opens them', async () => {
        await render('owner', '');
        expect(m.fetch.mock.calls.some(([url]) => url.startsWith('/api/workspace/operations') || url.startsWith('/api/workspace/budget'))).toBe(false);
        const button = view.root.findAllByType('button').find(b => b.findAllByType('span').some(s => s.children.includes('Detailed team results')))!;
        expect(button.props['aria-expanded']).toBe(false);
        await act(async () => button.props.onClick());
        await act(async () => { await vi.advanceTimersByTimeAsync(300); });
        expect(m.fetch.mock.calls.some(([url]) => url.startsWith('/api/workspace/operations'))).toBe(true);
        expect(button.props['aria-expanded']).toBe(true);
    });
    it('does not display the previous area as a completed report while the next area is loading', async () => {
        await render('owner', '');
        const normal = m.fetch.getMockImplementation()!;
        let finish!: (response: Response) => void;
        m.fetch.mockImplementation((url: string) => url.startsWith('/api/workspace?') && url.includes('view=accounts') ? new Promise<Response>(resolve => { finish = resolve; }) : normal(url));
        m.params = new URLSearchParams('view=accounts');
        await act(async () => { view.update(createElement(Page)); });
        expect(view.root.findByProps({ role: 'status' }).children).toContain('Loading…');
        expect(JSON.stringify(view.toJSON())).not.toContain('Create account');
        await act(async () => { finish(Response.json(dashboard('owner'))); });
        expect(JSON.stringify(view.toJSON())).toContain('Create account');
    });

    it('searches clients without repeating the dashboard finance and capacity reads', async () => {
        await render();
        const dashboardReads = () => m.fetch.mock.calls.filter(([url]) => url.startsWith('/api/workspace?'));
        const before = dashboardReads().length;
        const search = view.root.findAllByType('input').find(input => input.props.placeholder?.startsWith('Search client'))!;
        for (const value of ['s', 'se', 'searchable']) await act(async () => search.props.onChange({ target: { value } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(249); });
        expect(m.fetch.mock.calls.filter(([url]) => url.startsWith('/api/workspace/contacts?') && url.includes('search=searchable'))).toHaveLength(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(m.fetch.mock.calls.filter(([url]) => url.startsWith('/api/workspace/contacts?') && url.includes('search=searchable'))).toHaveLength(1);
        expect(dashboardReads()).toHaveLength(before);
        expect(JSON.stringify(view.toJSON())).toContain('Searchable Client');
    });

    it('offers a retry after an unavailable workspace without presenting it as an empty successful report', async () => {
        m.params = new URLSearchParams('view=accounts');
        m.fetch.mockImplementation(async (url: string) => url === '/api/pages' ? Response.json({ pages: [] }) : Response.json({ error: 'Source unavailable' }, { status: 503 }));
        await act(async () => { view = create(createElement(Page)); });
        expect(view.root.findByProps({ role: 'alert' }).children).toContain('Source unavailable');
        expect(JSON.stringify(view.toJSON())).not.toContain('Create account');
        m.fetch.mockImplementation(async () => Response.json(dashboard('manager')));
        await act(async () => view.root.findAllByType('button').find(button => button.children.includes('Try again'))!.props.onClick());
        expect(JSON.stringify(view.toJSON())).toContain('Create account');
    });

    it('ignores a late client search response after the user has changed the search', async () => {
        await render();
        const normal = m.fetch.getMockImplementation()!;
        let finish!: (response: Response) => void, signal: AbortSignal | undefined;
        m.fetch.mockImplementation((url: string, options: any) => url.startsWith('/api/workspace/contacts?') && url.includes('search=old') ? (signal = options.signal, new Promise<Response>(resolve => { finish = resolve; })) : normal(url));
        const search = view.root.findAllByType('input').find(input => input.props.placeholder?.startsWith('Search client'))!;
        await act(async () => search.props.onChange({ target: { value: 'old' } }));
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        await act(async () => search.props.onChange({ target: { value: 'searchable' } }));
        expect(signal?.aborted).toBe(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        await act(async () => { finish(Response.json({ items: [{ id: 'stale', name: 'Obsolete search result' }], total: 1 })); });
        expect(JSON.stringify(view.toJSON())).toContain('Searchable Client');
        expect(JSON.stringify(view.toJSON())).not.toContain('Obsolete search result');
    });
});
