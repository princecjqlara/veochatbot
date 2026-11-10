import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ session: vi.fn(), fetch: vi.fn(), assign: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: m.session }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
import VeoPageConnections from './VeoPageConnections';
let view: ReactTestRenderer;
const pages = [
    { id: 'one', facebookPageId: '101', name: 'Connected Page', enabled: true, status: 'ready' },
    { id: 'two', facebookPageId: '102', name: 'Expired Page', enabled: true, status: 'reconnect_required' },
    { id: 'three', facebookPageId: '103', name: 'Unknown Page', enabled: true, status: 'unknown' },
    { id: 'four', facebookPageId: '104', name: 'Disabled Page', enabled: false, status: 'disabled' }
];
const directory = () => ({ pages, authorization: { active: false, configured: true, expiresAt: null }, callbackUrl: 'https://veo.test/api/auth/callback/facebook' });
const content = (value: any): string => typeof value === 'string' || typeof value === 'number' ? String(value) : (value?.children || []).map(content).join('');
beforeEach(() => {
    vi.clearAllMocks(); m.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'owner', role: 'owner' } } });
    vi.stubGlobal('window', { location: { search: '', assign: m.assign } }); vi.stubGlobal('fetch', m.fetch);
    m.fetch.mockImplementation(async (url: string, options?: any) => {
        if (url.startsWith('/api/workspace/pages')) return Response.json(directory());
        if (url === '/api/facebook/authorize') return Response.json({ authorizationUrl: 'https://www.facebook.com/dialog/oauth' });
        if (url === '/api/facebook/connect') { const body = JSON.parse(options.body); return Response.json({ success: true, saved: true, webhookSubscribed: true, pageId: body.pageId || 'new', message: 'Connection saved; existing data retained.' }); }
        if (url.includes('submit-all')) return Response.json({ summary: { approved: 1, pending: 2, remaining: 0, hasMore: false, errors: 0 } });
        if (url.includes('/contacts/sync')) return Response.json({ inserted: 1, complete: true });
        return Response.json({ pages: [] });
    });
});
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); });
async function render() { await act(async () => { view = create(createElement(VeoPageConnections)); }); }
const button = (label: string) => view.root.findAllByType('button').find(node => content(node) === label)!;
it.each(['member', 'manager', 'team_leader'])('keeps Owner setup unavailable to %s without reading private connections', async role => {
    m.session.mockReturnValue({ status: 'authenticated', data: { user: { id: 'worker', role } } }); await render();
    expect(content(view.toJSON())).toContain('Only the workspace Owner'); expect(m.fetch).not.toHaveBeenCalled();
});
it('lists expired, unknown and disabled saved Pages and keeps old management tools reachable', async () => {
    await render();
    for (const page of pages) expect(content(view.toJSON())).toContain(page.name);
    for (const label of ['Reconnect all saved Pages', 'Sync all connected Pages', 'Setup templates', 'Sync contacts', 'Manage team access', 'Contacts & bulk tools', 'AI chatbot', 'Telegram routing']) expect(content(view.toJSON())).toContain(label);
    expect(content(view.toJSON())).toContain('Unable to verify');
    await act(async () => view.root.findByProps({ 'aria-label': 'Filter connection status' }).props.onChange({ target: { value: 'disabled' } }));
    expect(view.root.findAllByType('tbody')[0].findAllByType('tr')).toHaveLength(1);
    await act(async () => view.root.findByProps({ 'aria-label': 'Filter connection status' }).props.onChange({ target: { value: 'all' } }));
    expect(view.root.findAllByType('tbody')[0].findAllByType('tr')).toHaveLength(4);
});
it('starts Page authorization without replacing the VEO sign-in session', async () => {
    await render(); await act(async () => button('Authorize Facebook Pages').props.onClick());
    expect(m.assign).toHaveBeenCalledWith('https://www.facebook.com/dialog/oauth');
    expect(m.fetch.mock.calls.some(([url]) => url.includes('/api/auth/signin'))).toBe(false);
});
it('reconnects every selected saved Page even when another Page fails', async () => {
    await render();
    await act(async () => view.root.findAllByType('input').find(input => input.props.type === 'checkbox' && !input.props['aria-label'])!.props.onChange({ target: { checked: false } }));
    for (const name of ['Connected Page', 'Expired Page']) await act(async () => view.root.findByProps({ 'aria-label': 'Select ' + name }).props.onChange({ target: { checked: true } }));
    const normal = m.fetch.getMockImplementation()!;
    m.fetch.mockImplementation(async (url, options) => url === '/api/facebook/connect' && JSON.parse(options.body).pageId === 'one' ? Response.json({ error: 'Renew Page permission' }, { status: 409 }) : normal(url, options));
    await act(async () => button('Reconnect selected').props.onClick());
    const writes = m.fetch.mock.calls.filter(([url]) => url === '/api/facebook/connect').map(([, options]) => JSON.parse(options.body));
    expect(writes).toEqual([{ pageId: 'one', source: 'stored' }, { pageId: 'two', source: 'stored' }]);
    expect(content(view.toJSON())).toContain('1 Pages reconnected; 1 need attention'); expect(content(view.toJSON())).toContain('Renew Page permission');
});
it('continues missing-template batches and reports failures without losing a Page connection', async () => {
    await render(); let batches = 0; const normal = m.fetch.getMockImplementation()!;
    m.fetch.mockImplementation(async (url, options) => url.includes('submit-all') ? Response.json({ summary: { approved: 0, pending: 2, remaining: ++batches === 1 ? 2 : 0, hasMore: batches === 1, errors: 0 } }) : normal(url, options));
    await act(async () => button('Setup templates').props.onClick()); expect(batches).toBe(2);
    expect(content(view.toJSON())).toContain('0 remaining');
});
it('syncs all contact-identity batches and leaves financial/history imports untouched', async () => {
    await render(); let batches = 0; const normal = m.fetch.getMockImplementation()!;
    m.fetch.mockImplementation(async (url, options) => url.includes('/contacts/sync') ? Response.json({ inserted: 2, complete: ++batches === 2, next_cursor: batches === 1 ? 'next' : null }) : normal(url, options));
    await act(async () => button('Sync contacts').props.onClick());
    const writes = m.fetch.mock.calls.filter(([url]) => url.includes('/contacts/sync')).map(([, options]) => JSON.parse(options.body));
    expect(writes).toEqual([{ page_id: 'one', cursor: null }, { page_id: 'one', cursor: 'next' }]);
    expect(content(view.toJSON())).toContain('4 contact identities added. Sync complete.');
    expect(m.fetch.mock.calls.some(([url]) => /\/api\/pages\/.*\/sync/.test(url))).toBe(false);
});
it('leaves disabled Pages unchanged during a bulk reconnect', async () => {
    await render(); await act(async () => button('Reconnect all saved Pages').props.onClick());
    const writes = m.fetch.mock.calls.filter(([url]) => url === '/api/facebook/connect').map(([, options]) => JSON.parse(options.body));
    expect(writes.map(body => body.pageId)).toEqual(['one', 'two', 'three']);
    expect(content(view.toJSON())).toContain('1 disabled Pages left unchanged');
});

function authorizedSetup(callback = true) {
    let current = pages.map(page => ({ ...page }));
    const available = [...pages.map(page => ({ id: page.facebookPageId, name: page.name })), { id: '999', name: 'New authorized Page' }];
    const location = { search: callback ? '?authorized=1&keep=yes' : '', pathname: '/dashboard/connect', hash: '' };
    const replaceState = vi.fn((_state, _title, path: string) => { location.search = new URL(path, 'https://veo.test').search; });
    vi.stubGlobal('window', { location, history: { state: { navigation: 'retained' }, replaceState } });
    const normal = m.fetch.getMockImplementation()!;
    m.fetch.mockImplementation(async (url: string, options?: any) => {
        if (url.startsWith('/api/workspace/pages')) return Response.json({ ...directory(), pages: current, authorization: { active: true, configured: true, expiresAt: '2026-11-10T15:00:00Z' } });
        if (url === '/api/facebook/pages') return Response.json({ pages: available });
        if (url === '/api/facebook/connect') {
            const body = JSON.parse(options.body), page = current.find(page => page.facebookPageId === body.facebookPageId || page.id === body.pageId)!;
            current = current.map(item => item.id === page.id ? { ...item, status: 'ready' } : item);
            return Response.json({ success: true, saved: true, webhookSubscribed: true, pageId: page.id, message: 'Page reconnected.' });
        }
        return normal(url, options);
    });
    return { replaceState, current: () => current, setPages: (value: typeof current) => { current = value; } };
}
const connectionWrites = () => m.fetch.mock.calls.filter(([url]) => url === '/api/facebook/connect').map(([, options]) => JSON.parse(options.body));
it('finishes enabled saved Page connections once after OAuth using fresh authorization, leaving new and disabled Pages for explicit actions', async () => {
    const setup = authorizedSetup();
    setup.setPages([...setup.current(), { id: 'unlisted', facebookPageId: '105', name: 'Unlisted Page', enabled: true, status: 'reconnect_required' }]);
    await render();
    expect(connectionWrites()).toEqual(['101', '102', '103'].map(facebookPageId => ({ facebookPageId, source: 'authorization' })));
    expect(setup.replaceState).toHaveBeenCalledWith({ navigation: 'retained' }, '', '/dashboard/connect?keep=yes');
    expect(m.fetch.mock.calls.some(([url]) => url.includes('submit-all') || url.includes('/contacts/sync'))).toBe(false);
    expect(setup.current().find(page => page.id === 'four')?.enabled).toBe(false);
    expect(content(view.toJSON())).toContain('3 Pages reconnected; 0 need attention');
    expect(m.fetch.mock.calls.some(([url]) => url === '/api/workspace/pages?refresh=1')).toBe(true);
    await act(async () => view.unmount()); await render();
    expect(connectionWrites()).toHaveLength(3);
});
it('keeps an active grant read-only on a normal visit and provides a finish action for incomplete connections', async () => {
    authorizedSetup(false); await render(); expect(connectionWrites()).toEqual([]);
    expect(content(view.toJSON())).toContain('2 authorized saved Pages still need connection setup.');
    await act(async () => button('Finish saved Page setup').props.onClick());
    expect(connectionWrites()).toEqual(['102', '103'].map(facebookPageId => ({ facebookPageId, source: 'authorization' })));
    expect(view.root.findAllByType('button').some(node => content(node) === 'Finish saved Page setup')).toBe(false);
    expect(m.fetch.mock.calls.some(([url]) => url.includes('submit-all') || url.includes('/contacts/sync'))).toBe(false);
});
it('waits for discovery before reconnecting and never falls back to old stored credentials during that load', async () => {
    authorizedSetup(); const normal = m.fetch.getMockImplementation()!; let complete!: (value: Response) => void;
    m.fetch.mockImplementation((url, options) => url === '/api/facebook/pages' ? new Promise<Response>(resolve => { complete = resolve; }) : normal(url, options));
    await render(); expect(connectionWrites()).toEqual([]); expect(button('Reconnect all saved Pages').props.disabled).toBe(true);
    await act(async () => button('Reconnect all saved Pages').props.onClick()); expect(connectionWrites()).toEqual([]);
    await act(async () => complete(Response.json({ pages: pages.map(page => ({ id: page.facebookPageId, name: page.name })) })));
    expect(connectionWrites()).toHaveLength(3); expect(connectionWrites().every(body => body.source === 'authorization')).toBe(true);
});
it('shows discovery errors without reconnecting and finishes after reloading available Pages', async () => {
    authorizedSetup(); const normal = m.fetch.getMockImplementation()!; let failed = true;
    m.fetch.mockImplementation((url, options) => url === '/api/facebook/pages' && failed ? Response.json({ error: 'Facebook Page listing unavailable' }, { status: 503 }) : normal(url, options));
    await render(); expect(connectionWrites()).toEqual([]); expect(content(view.toJSON())).toContain('Facebook Page listing unavailable');
    expect(button('Reconnect all saved Pages').props.disabled).toBe(true);
    failed = false; await act(async () => button('Reload available Pages').props.onClick()); expect(connectionWrites()).toHaveLength(3);
});
it('continues after a webhook failure and retries only the unfinished authorized Page', async () => {
    authorizedSetup(); const normal = m.fetch.getMockImplementation()!; let fail = true;
    m.fetch.mockImplementation((url, options) => url === '/api/facebook/connect' && JSON.parse(options.body).facebookPageId === '102' && fail
        ? Response.json({ saved: true, success: false, webhookSubscribed: false, code: 'WEBHOOK_SETUP_INCOMPLETE', error: 'Live updates still need setup.' }, { status: 409 }) : normal(url, options));
    await render(); expect(connectionWrites()).toHaveLength(3); expect(content(view.toJSON())).toContain('2 Pages reconnected; 1 need attention');
    expect(content(view.toJSON())).toContain('Live updates still need setup.');
    fail = false; await act(async () => button('Finish saved Page setup').props.onClick());
    expect(connectionWrites().slice(3)).toEqual([{ facebookPageId: '102', source: 'authorization' }]);
    expect(content(view.toJSON())).toContain('1 Pages reconnected; 0 need attention');
});
it('does not report a connection complete when an HTTP success lacks webhook confirmation', async () => {
    const setup = authorizedSetup(false); setup.setPages([pages[1]]); const normal = m.fetch.getMockImplementation()!;
    m.fetch.mockImplementation((url, options) => url === '/api/facebook/connect' ? Response.json({ success: true, saved: true, pageId: 'two', webhookSubscribed: false }) : normal(url, options));
    await render(); await act(async () => button('Finish saved Page setup').props.onClick());
    expect(content(view.toJSON())).toContain('0 Pages reconnected; 1 need attention');
    expect(content(view.toJSON())).toContain('Reconnect required'); expect(button('Finish saved Page setup')).toBeDefined();
});
it('stops between Page requests and leaves remaining setup available for retry', async () => {
    authorizedSetup(); const normal = m.fetch.getMockImplementation()!; let finish!: () => Promise<void>;
    m.fetch.mockImplementation((url, options) => url === '/api/facebook/connect' && JSON.parse(options.body).facebookPageId === '101'
        ? new Promise<Response>(resolve => { finish = async () => { resolve(await normal(url, options)); }; }) : normal(url, options));
    await render(); expect(connectionWrites()).toHaveLength(1);
    await act(async () => button('Stop after current request').props.onClick());
    await act(async () => finish());
    expect(connectionWrites()).toHaveLength(1); expect(content(view.toJSON())).toContain('Stopped. Remaining Pages were not changed.');
    await act(async () => button('Finish saved Page setup').props.onClick());
    expect(connectionWrites().slice(1)).toEqual(['102', '103'].map(facebookPageId => ({ facebookPageId, source: 'authorization' })));
});
it('leaves new Pages selectable when authorization contains no enabled saved Pages', async () => {
    const setup = authorizedSetup(); setup.setPages([pages[3]]); await render();
    expect(connectionWrites()).toEqual([]); expect(content(view.toJSON())).toContain('Facebook authorization complete. Choose a Page below to connect.');
    expect(view.root.findAllByType('button').some(node => content(node) === 'Connect Page')).toBe(true);
});
