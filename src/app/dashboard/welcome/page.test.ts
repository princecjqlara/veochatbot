import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'owner', role: 'owner' } } }) }));
import Page from './page';
let view: ReactTestRenderer;
beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.stubGlobal('fetch', m.fetch); vi.stubGlobal('window', { location: { search: '' } });
    m.fetch.mockImplementation(async (path: string) => path === '/api/pages' ? Response.json({ pages: [{ id: 'one', name: 'Page One' }, { id: 'two', name: 'Page Two' }] }) : Response.json({ config: { page_id: 'one', enabled: false, message_text: 'Saved greeting', buttons: [] } }));
});
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const save = () => view.root.findAllByType('button').find(button => button.children.includes('Save'))!;
it('blocks saving unavailable settings and shows a retry instead of inventing an empty configuration', async () => {
    const normal = m.fetch.getMockImplementation()!; m.fetch.mockImplementation(async path => path.includes('/welcome') ? Response.json({ error: 'Settings unavailable' }, { status: 503 }) : normal(path));
    await act(async () => { view = create(createElement(Page)); });
    expect(save().props.disabled).toBe(true); expect(JSON.stringify(view.toJSON())).toContain('Settings unavailable'); expect(view.root.findAllByType('textarea')).toHaveLength(0);
    m.fetch.mockImplementation(normal);
    await act(async () => view.root.findAllByType('button').find(button => button.children.includes('Retry welcome settings'))!.props.onClick());
    expect(save().props.disabled).toBe(false); expect(view.root.findByType('textarea').props.value).toBe('Saved greeting');
});
it('ignores the old Page response after switching Pages and saves only the current Page draft', async () => {
    const normal = m.fetch.getMockImplementation()!; let finish!: (response: Response) => void;
    m.fetch.mockImplementation((path: string) => path === '/api/pages/one/welcome' ? new Promise<Response>(resolve => { finish = resolve; }) : normal(path));
    await act(async () => { view = create(createElement(Page)); }); expect(save().props.disabled).toBe(true);
    await act(async () => view.root.findByProps({ 'aria-label': 'Welcome Page' }).props.onChange({ target: { value: 'two' } }));
    await act(async () => { finish(Response.json({ config: { page_id: 'one', enabled: true, message_text: 'Obsolete greeting', buttons: [] } })); });
    expect(view.root.findByType('textarea').props.value).toBe('Saved greeting');
    await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: 'Current Page draft' } }));
    m.fetch.mockResolvedValueOnce(Response.json({ success: true }));
    await act(async () => save().props.onClick());
    const writes = m.fetch.mock.calls.filter(([, options]) => options?.method === 'PUT');
    expect(writes).toHaveLength(1); expect(writes[0][0]).toBe('/api/pages/two/welcome'); expect(JSON.parse(writes[0][1].body).message_text).toBe('Current Page draft');
});
it('reports a failed save and retains the typed welcome message for retry', async () => {
    await act(async () => { view = create(createElement(Page)); });
    await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: 'Do not lose my draft' } }));
    m.fetch.mockResolvedValueOnce(Response.json({ error: 'Page access was revoked' }, { status: 403 }));
    await act(async () => save().props.onClick());
    expect(view.root.findByProps({ role: 'alert' }).children).toContain('Page access was revoked'); expect(view.root.findByType('textarea').props.value).toBe('Do not lose my draft');
});
