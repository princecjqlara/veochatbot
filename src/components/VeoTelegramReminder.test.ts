import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard/workspace' }));
vi.mock('next/link', () => ({ default: ({ href, children }: any) => createElement('a', { href }, children) }));
import Reminder from './VeoTelegramReminder';
let view: ReactTestRenderer;
afterEach(async () => { if (view) await act(async () => view.unmount());vi.unstubAllGlobals(); });
it('keeps a profile reminder for a saved username until the Telegram account is linked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ linked: false }))));
    await act(async () => { view = create(createElement(Reminder, { username: 'worker' })); });
    expect(JSON.stringify(view.toJSON())).toContain('Link your Telegram account once');
    expect(view.root.findByType('a').props.href).toBe('/dashboard/workspace?view=profile');
});
it('clears the reminder when both the username and verified identity are present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ linked: true }))));
    await act(async () => { view = create(createElement(Reminder, { username: 'worker' })); });
    expect(view.toJSON()).toBeNull();
});
