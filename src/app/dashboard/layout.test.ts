import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ session: vi.fn(), push: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: m.session, signOut: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push }), usePathname: () => '/dashboard/workspace' }));
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => createElement('a', { href, ...props }, children) }));
import Layout from './layout';
afterEach(() => { vi.unstubAllGlobals(); });
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

it.each(['owner', 'team_leader'])('keeps %s Contacts and tag management available alongside the Teams Dashboard', async role => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ pages: [] }))));
    m.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'head', role, telegramProfileConfirmed: true } } });
    let view: any; await act(async () => { view = create(createElement(Layout, null, 'Workspace')); });
    try {
        const links = view.root.findAllByType('a').map((a: any) => a.props.href);
        expect(links).toContain('/dashboard/contacts'); expect(links).toContain('/dashboard/tags'); expect(links).toContain('/dashboard/workspace');
    } finally { await act(async () => view.unmount()); }
});
