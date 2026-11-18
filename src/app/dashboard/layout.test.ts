import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ session: vi.fn(), push: vi.fn(), params: new URLSearchParams() }));
vi.mock('next-auth/react', () => ({ useSession: m.session, signOut: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push }), usePathname: () => '/dashboard/workspace', useSearchParams: () => m.params }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => createElement('a', { href, ...props }, children) }));
import Layout from './layout';
it('withholds private tools during an outage and rechecks the session on reconnect', async () => {
    const update = vi.fn().mockResolvedValue({ user: { workspaceUnavailable: true } });
    m.session.mockReturnValue({ status: 'authenticated', update, data: { user: { id: 'member', workspaceUnavailable: true } } });
    let view: any;await act(async () => { view = create(createElement(Layout, null, createElement('div', { id: 'private-workspace' }, 'Private data'))); });
    try {
        expect(view.root.findAllByProps({ id: 'private-workspace' })).toHaveLength(0);
        expect(view.root.findAllByType('a')).toHaveLength(0);
        expect(view.root.findByType('h1').children).toContain('VEO is temporarily unavailable');
        await act(async () => view.root.findAllByType('button').find((b: any) => b.children.includes('Reconnect')).props.onClick());
        expect(update).toHaveBeenCalledOnce();
        expect(JSON.stringify(view.toJSON())).toContain('The connection is still unavailable. Please try again shortly.');
        m.session.mockReturnValue({ status: 'authenticated', update, data: { user: { id: 'member', role: 'member', telegramProfileConfirmed: true } } });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ linked: true })));
        await act(async () => view.update(createElement(Layout, null, createElement('div', { id: 'private-workspace' }, 'Private data'))));
        expect(view.root.findAllByProps({ id: 'private-workspace' })).toHaveLength(1);
    } finally { await act(async () => view.unmount()); }
});
afterEach(() => { vi.unstubAllGlobals();m.params = new URLSearchParams(); });
it('shows only suspension details and sign-out while withholding the workspace and member controls', async () => {
    m.session.mockReturnValue({ status: 'authenticated', data: { user: { suspension: { id: 'suspension', reason: 'Supervisor conduct review', ends_at: null } } } });
    let view: any;await act(async () => { view = create(createElement(Layout, null, createElement('div', { id: 'private-workspace' }, 'Private data'))); });
    try {
        expect(view.root.findAllByProps({ id: 'private-workspace' })).toHaveLength(0);
        expect(view.root.findByType('h1').children).toContain('Account suspended');
        expect(view.root.findAllByType('a')).toHaveLength(0);
        expect(view.root.findByType('button').children).toContain('Sign out');
    } finally { await act(async () => view.unmount()); }
});
it('gives CJ the calendar, ads performance and capacity links while keeping those financial reports off worker navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ pages: [] }))));
    m.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'user', role: 'owner', telegramProfileConfirmed: true } } });
    let view: any; await act(async () => { view = create(createElement(Layout, null, 'Workspace')); });
    try {
        const links = () => view.root.findAllByType('a').map((a: any) => a.props.href);
        expect(links()).toContain('/dashboard/ad-calendar'); expect(links()).toContain('/dashboard/ad-quality');
        expect(links()).toContain('/dashboard/workspace?view=capacity');
        m.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'user', role: 'member', telegramProfileConfirmed: true } } });
        await act(async () => { view.update(createElement(Layout, null, 'Workspace')); });
        expect(links()).not.toContain('/dashboard/ad-calendar'); expect(links()).not.toContain('/dashboard/ad-quality'); expect(links()).toContain('/dashboard/workspace?view=capacity');
    } finally { await act(async () => view.unmount()); }
});

it('opens the current query-based section, keeps one active area and closes the mobile menu after navigation', async () => {
    const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ linked: true })));vi.stubGlobal('fetch', fetcher);
    m.params = new URLSearchParams('view=accounts');
    m.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'head', role: 'owner', telegramProfileConfirmed: true, telegramUsername: 'head' } } });
    let view: any;await act(async () => { view = create(createElement(Layout, null, 'Workspace')); });
    try {
        const active = view.root.findAllByType('a').filter((a: any) => a.props['aria-current'] === 'page');
        expect(active.map((a: any) => a.props.href)).toEqual(['/dashboard/workspace?view=accounts']);
        expect(view.root.findAllByType('details').filter((d: any) => d.props.open)).toHaveLength(1);
        expect(fetcher.mock.calls.some(([url]) => url === '/api/pages')).toBe(false);
        await act(async () => view.root.findByProps({ 'aria-label': 'Open menu' }).props.onClick());
        expect(view.root.findByProps({ 'aria-label': 'Close menu' }).props['aria-expanded']).toBe(true);
        await act(async () => active[0].props.onClick());
        expect(view.root.findByProps({ 'aria-label': 'Open menu' }).props['aria-expanded']).toBe(false);
    } finally { await act(async () => view.unmount()); }
});

it.each(['owner', 'team_leader'])('keeps %s Contacts and tag management available alongside the Teams Dashboard', async role => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ pages: [] }))));
    m.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'head', role, telegramProfileConfirmed: true } } });
    let view: any; await act(async () => { view = create(createElement(Layout, null, 'Workspace')); });
    try {
        const links = view.root.findAllByType('a').map((a: any) => a.props.href);
        expect(links).toContain('/dashboard/contacts'); expect(links).toContain('/dashboard/tags'); expect(links).toContain('/dashboard/workspace');
    } finally { await act(async () => view.unmount()); }
});

it('finds permitted tools across collapsed groups and restores all destinations after clearing search', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ linked: true })));
    m.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'worker', role: 'member', telegramProfileConfirmed: true, telegramUsername: 'worker' } } });
    let view: any; await act(async () => { view = create(createElement(Layout, null, 'Workspace')); });
    try {
        const destinations = () => view.root.findAllByType('a').filter((a: any) => a.props.href.startsWith('/dashboard')).map((a: any) => a.props.href);
        const before = destinations();
        await act(async () => view.root.findByProps({ 'aria-label': 'Find a page' }).props.onChange({ target: { value: 'receipts' } }));
        expect(destinations()).toEqual(['/dashboard/workspace', '/dashboard/workspace?view=receipts']);
        expect(view.root.findAllByType('details').every((d: any) => d.props.open)).toBe(true);
        await act(async () => view.root.findByProps({ 'aria-label': 'Find a page' }).props.onChange({ target: { value: 'ads performance' } }));
        expect(destinations()).not.toContain('/dashboard/ad-quality');
        await act(async () => view.root.findByProps({ 'aria-label': 'Clear page search' }).props.onClick());
        expect(destinations()).toEqual(before);
        expect(view.root.findByProps({ href: '#main-content' })).toBeTruthy();
    } finally { await act(async () => view.unmount()); }
});
