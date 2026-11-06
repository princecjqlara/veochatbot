import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ signIn: vi.fn(), signOut: vi.fn(), session: vi.fn(), replace: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: m.session, signIn: m.signIn, signOut: m.signOut }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: m.replace }), useSearchParams: () => new URLSearchParams() }));
import VeoSignIn from './VeoSignIn';
beforeEach(() => { vi.clearAllMocks(); m.session.mockReturnValue({ status: 'unauthenticated', data: null }); });
afterEach(() => { vi.unstubAllGlobals(); });
it('offers email/password only for all four roles, including Owner', async () => {
    let view: any; await act(async () => { view = create(createElement(VeoSignIn)); });
    try {
        for (const role of ['member', 'manager', 'team_leader', 'owner']) {
            await act(async () => view.root.findAllByType('input').find((i: any) => i.props.type === 'radio' && i.props.value === role).props.onChange());
            expect(JSON.stringify(view.toJSON())).not.toContain('Facebook');
            expect(view.root.findByProps({ name: 'email' })).toBeTruthy(); expect(view.root.findByProps({ name: 'password' })).toBeTruthy();
        }
    } finally { await act(async () => view.unmount()); }
});
it('clears an invalidated old Facebook session so the email login screen remains usable', async () => {
    m.session.mockReturnValue({ status: 'authenticated', data: { user: {} } });
    let view: any; await act(async () => { view = create(createElement(VeoSignIn)); });
    try { expect(m.signOut).toHaveBeenCalledWith({ callbackUrl: '/' }); expect(m.replace).not.toHaveBeenCalled(); }
    finally { await act(async () => view.unmount()); }
});
