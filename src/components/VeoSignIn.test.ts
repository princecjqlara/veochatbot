import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ status: 'unauthenticated', data: null }), signIn: m.signIn }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
import VeoSignIn from './VeoSignIn';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('offers Facebook only for CJ’s Owner selection while preserving email/password sign-in for every role', async () => {
    const document = { cookie: '' }; vi.stubGlobal('document', document); vi.stubGlobal('location', { protocol: 'https:' });
    let view: any; await act(async () => { view = create(createElement(VeoSignIn)); });
    const facebookButtons = () => view.root.findAllByType('button').filter((b: any) => JSON.stringify(b.props.children).includes('Continue with Facebook'));
    try {
        for (const role of ['member', 'manager', 'team_leader']) {
            await act(async () => view.root.findAllByType('input').find((i: any) => i.props.type === 'radio' && i.props.value === role).props.onChange());
            expect(facebookButtons()).toHaveLength(0);
            expect(view.root.findByProps({ name: 'email' })).toBeTruthy(); expect(view.root.findByProps({ name: 'password' })).toBeTruthy();
        }
        await act(async () => view.root.findAllByType('input').find((i: any) => i.props.type === 'radio' && i.props.value === 'owner').props.onChange());
        expect(facebookButtons()).toHaveLength(1);
        await act(async () => facebookButtons()[0].props.onClick());
        expect(document.cookie).toContain('veo-login-role=owner');
        expect(m.signIn).toHaveBeenCalledWith('facebook', expect.any(Object), expect.any(Object));
    } finally { await act(async () => view.unmount()); }
});
