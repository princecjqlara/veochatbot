import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { telegramUsername: 'previous_name', telegramProfileCompleted: true } }, update: m.update }) }));
import VeoTelegramProfile from './VeoTelegramProfile';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('prefills the saved username and saves an explicit no-username declaration before refreshing the session', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ telegram_username: null })));
    vi.stubGlobal('fetch', fetcher);
    let view: any; await act(async () => { view = create(createElement(VeoTelegramProfile, { confirmation: true })); });
    try {
        expect(view.root.findByProps({ name: 'telegram_username' }).props.value).toBe('previous_name');
        expect(JSON.stringify(view.toJSON())).toContain('Confirm your Telegram username');
        await act(async () => view.root.findAllByType('input').find((i: any) => i.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }));
        await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ username: '', no_username: true });
        expect(m.update).toHaveBeenCalledTimes(1);
    } finally { await act(async () => view.unmount()); }
});
