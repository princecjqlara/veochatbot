import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ signIn: vi.fn(), signOut: vi.fn(), session: vi.fn(), replace: vi.fn(), push: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: m.session, signIn: m.signIn, signOut: m.signOut }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: m.replace, push: m.push }), useSearchParams: () => new URLSearchParams() }));
import VeoSignIn from './VeoSignIn';
beforeEach(() => { vi.clearAllMocks(); m.session.mockReturnValue({ status: 'unauthenticated', data: null }); });
afterEach(() => { vi.unstubAllGlobals(); });
it('offers email/password only for all four roles, including Owner', async () => {
    let view: any; await act(async () => { view = create(createElement(VeoSignIn)); });
    try {
        expect(view.root.findAllByType('input').filter((i: any) => i.props.type === 'radio')).toHaveLength(0);
        expect(JSON.stringify(view.toJSON())).not.toContain('Facebook');
        expect(view.root.findByProps({ name: 'email' })).toBeTruthy(); expect(view.root.findByProps({ name: 'password' })).toBeTruthy();
    } finally { await act(async () => view.unmount()); }
});
it.each(['DatabaseUnavailable', 'TooManyAttempts', 'CredentialsSignin', 'NetworkUnavailable'])('explains %s without mislabeling it as a role selection failure', async code => {
    vi.stubGlobal('FormData', class { get(key: string) { return key === 'email' ? 'member@example.com' : 'password'; } });
    if (code === 'NetworkUnavailable') m.signIn.mockRejectedValueOnce(new Error('offline'));
    else m.signIn.mockResolvedValueOnce({ ok: false, error: code });
    let view: any; await act(async () => { view = create(createElement(VeoSignIn)); });
    try {
        await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: {} }));
        const message = view.root.findByProps({ role: 'alert' }).children.join('');
        expect(message).not.toContain('selected role');
        expect(message).toContain(code === 'DatabaseUnavailable' ? 'database is not responding' : code === 'TooManyAttempts' ? '15 minutes' : code === 'NetworkUnavailable' ? 'could not be reached' : 'email and password');
        expect(m.push).not.toHaveBeenCalled();
        expect(view.root.findByType('button').props.disabled).toBe(false);
    } finally { await act(async () => view.unmount()); }
});
it('clears an invalidated old Facebook session so the email login screen remains usable', async () => {
    m.session.mockReturnValue({ status: 'authenticated', data: { user: {} } });
    let view: any; await act(async () => { view = create(createElement(VeoSignIn)); });
    try { expect(m.signOut).toHaveBeenCalledWith({ callbackUrl: '/' }); expect(m.replace).not.toHaveBeenCalled(); }
    finally { await act(async () => view.unmount()); }
});
it('retains an authenticated identity during a database outage without granting workspace access', async () => {
    m.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'member', workspaceUnavailable: true } } });
    let view: any; await act(async () => { view = create(createElement(VeoSignIn)); });
    try {
        expect(m.signOut).not.toHaveBeenCalled(); expect(m.replace).not.toHaveBeenCalled();
        expect(view.root.findByProps({ role: 'alert' }).children.join('')).toContain('database is not responding');
    } finally { await act(async () => view.unmount()); }
});
