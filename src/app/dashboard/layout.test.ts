import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ session: vi.fn(), push: vi.fn(), params: new URLSearchParams() }));
vi.mock('next-auth/react', () => ({ useSession: m.session, signOut: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push }), usePathname: () => '/dashboard/workspace', useSearchParams: () => m.params }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => createElement('a', { href, ...props }, children) }));
import Layout from './layout';
afterEach(() => { vi.unstubAllGlobals();m.params = new URLSearchParams(); });
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
