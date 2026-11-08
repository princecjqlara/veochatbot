import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn(), fetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => m.params, useRouter: () => ({ replace: m.replace }) }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => createElement('a', { href, ...props }, children) }));
import Page from './page';
let view: ReactTestRenderer;
function dashboard(role = 'member') {
    return { scope: { user_id: 'worker', role, launch_at: '2026-11-05T00:00:00Z' }, accounts: [{ id: 'worker', name: 'Worker', role: 'member' }],
        orders: [], teams: [], tomorrow: [], salary: [], submissions: [], sync: [], order_page: { total: 0 } };
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal('fetch', m.fetch); });
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function render(role = 'member', params = 'view=dashboard') {
    m.params = new URLSearchParams(params);
    m.fetch.mockImplementation(async (url: string) => {
        const query = new URL(url, 'https://veo.test');
        if (query.pathname === '/api/pages') return new Response(JSON.stringify({ pages: [{ id: 'page-1', name: 'VEO One' }, { id: 'page-2', name: 'VEO Two' }] }));
        if (query.pathname === '/api/workspace/operations') return new Response(JSON.stringify({ summary: {}, orders: [], finance: { days: [] }, employees: [], page_rankings: [], order_page: { total: 0 }, client_assignments: [] }));
        if (query.pathname === '/api/workspace/budget') return new Response(JSON.stringify({ plans: [], saved: [], defaults: {} }));
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
});
