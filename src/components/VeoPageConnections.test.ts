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
        if (url === '/api/facebook/connect') { const body = JSON.parse(options.body); return Response.json({ success: true, saved: true, pageId: body.pageId || 'new', message: 'Connection saved; existing data retained.' }); }
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
