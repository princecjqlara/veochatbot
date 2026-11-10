import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetch: vi.fn(), update: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ update: m.update }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
import TelegramLink from './VeoTelegramLink';
let view: ReactTestRenderer;
const content = (v: any): string => typeof v === 'string' ? v : (v?.children || []).map(content).join('');
const button = (label: string) => view.root.findAllByType('button').find(node => content(node) === label)!;
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal('fetch', m.fetch); m.fetch.mockResolvedValue(Response.json({ linked: true, telegram_user_id: '42' })); });
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { view = create(createElement(TelegramLink)); }); };
const enter = async () => act(async () => view.root.findByProps({ 'aria-label': 'One-time Telegram code' }).props.onChange({ target: { value: 'a'.repeat(48) } }));
it('opens and cancels relinking without unlinking or writing to Telegram', async () => {
    await mount(); expect(content(view.toJSON())).toContain('ID 42');
    await act(async () => button('Relink Telegram account').props.onClick()); expect(content(view.toJSON())).toContain('current link stays active');
    await enter(); await act(async () => button('Cancel relink').props.onClick());
    expect(button('Relink Telegram account')).toBeDefined(); expect(m.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
});
it('relinks only after a fresh code succeeds and binds replacement to the original linked identity', async () => {
    await mount(); await act(async () => button('Relink Telegram account').props.onClick()); await enter();
    m.fetch.mockResolvedValueOnce(Response.json({ linked: true, telegram_user_id: '84' })).mockResolvedValue(Response.json({ linked: true, telegram_user_id: '84' }));
    await act(async () => button('Verify and relink Telegram').props.onClick());
    const write = m.fetch.mock.calls.find(([, options]) => options?.method === 'POST')!;
    expect(JSON.parse(write[1].body)).toEqual({ code: 'a'.repeat(48), relink: true, expected_telegram_user_id: '42' });
    expect(content(view.toJSON())).toContain('ID 84'); expect(content(view.toJSON())).toContain('Telegram account relinked'); expect(m.update).toHaveBeenCalled();
});
it('retains the old connection and typed code when verification fails', async () => {
    await mount(); await act(async () => button('Relink Telegram account').props.onClick()); await enter();
    m.fetch.mockResolvedValueOnce(Response.json({ error: 'Membership could not be verified. Your existing link is retained.' }, { status: 503 }));
    await act(async () => button('Verify and relink Telegram').props.onClick());
    expect(content(view.toJSON())).toContain('ID 42'); expect(view.root.findByProps({ 'aria-label': 'One-time Telegram code' }).props.value).toBe('a'.repeat(48)); expect(m.update).not.toHaveBeenCalled();
});
it('keeps first-time linking separate from replacing an existing identity', async () => {
    m.fetch.mockResolvedValue(Response.json({ linked: false, telegram_user_id: null })); await mount(); await enter();
    m.fetch.mockResolvedValueOnce(Response.json({ linked: true })).mockResolvedValue(Response.json({ linked: true, telegram_user_id: '42' }));
    await act(async () => button('Link Telegram').props.onClick());
    expect(JSON.parse(m.fetch.mock.calls.find(([, options]) => options?.method === 'POST')![1].body)).toEqual({ code: 'a'.repeat(48) });
});
it('shows an unavailable status and lets the user retry instead of treating it as an unlinked account', async () => {
    m.fetch.mockResolvedValue(Response.json({ error: 'Status unavailable' }, { status: 503 })); await mount(); expect(view.root.findByProps({ role: 'alert' })).toBeDefined();
    expect(view.root.findAllByType('button').some(b => content(b) === 'Link Telegram')).toBe(false);
    m.fetch.mockResolvedValue(Response.json({ linked: true, telegram_user_id: '42' })); await act(async () => button('Refresh link status').props.onClick()); expect(button('Relink Telegram account')).toBeDefined();
});
