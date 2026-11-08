import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import Groups from './VeoTelegramGroups';
let view: ReactTestRenderer;
const text = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(text).join('');
const data = { scope: { role: 'owner' }, can_manage: true, coverage: 'Approved Jaucian groups', pages: [{ id: 'one', name: 'Page One' }, { id: 'two', name: 'Page Two' }],
    teams: [{ id: 'team', name: 'Manager Team', manager_id: 'manager' }], accounts: [{ user_id: 'manager', role: 'manager', name: 'Manager', page_ids: ['one', 'two'], telegram_user_id: 42 }],
    groups: [{ chat_id: -123, name: 'Group One', active: true, pages: [{ id: 'one', name: 'Page One', matched: true }] }, { chat_id: -456, name: 'Group Two', active: true, pages: [{ id: 'two', name: 'Page Two', matched: true }] }],
    links: [{ team_id: 'team', chat_id: -123 }, { team_id: 'team', chat_id: -456 }], routes: [{ team_id: 'team', page_id: 'one', chat_id: -123 }, { team_id: 'team', page_id: 'two', chat_id: -456 }],
    memberships: [{ user_id: 'manager', chat_id: -123 }, { user_id: 'manager', chat_id: -456 }] };
afterEach(async () => { if (view) await act(async () => view.unmount());vi.unstubAllGlobals(); });
async function mount(body = data) { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));await act(async () => { view = create(createElement(Groups)); }); }
it('shows fetched groups, their Pages and a manager’s multiple memberships without choosing a single replacement group', async () => {
    await mount();expect(text(view.toJSON())).toContain('Page One');expect(text(view.toJSON())).toContain('Page Two');
    expect(view.root.findAllByType('tbody')[0].findAllByType('tr')).toHaveLength(2);
    expect(text(view.toJSON())).toContain('Adding a group keeps this person’s other memberships');
    expect(view.root.findAllByType('button').some(b => text(b) === 'Fetch teams and Pages from Jaucian')).toBe(true);
});
it('lets a manager choose either eligible linked group while keeping Head discovery controls separate', async () => {
    await mount({ ...data, scope: { role: 'manager' } });
    expect(view.root.findAllByType('button').some(b => text(b).startsWith('Fetch teams'))).toBe(false);
    const person = view.root.findAllByType('select').find(s => s.findAllByType('option').some(o => o.props.value === 'manager'))!;
    await act(async () => person.props.onChange({ target: { value: 'manager' } }));
    const selectors = view.root.findAllByType('select').filter(s => s.findAllByType('option').some(o => o.props.value === '-123'));
    expect(selectors[1].findAllByType('option').map(o => o.props.value)).toEqual(['', '-123', '-456']);
});
it('unlinks only the selected membership and never sends an account-deletion action', async () => {
    await mount();const fetcher = vi.mocked(fetch);await act(async () => view.root.findAllByType('button').find(b => text(b) === 'Unlink group')!.props.onClick());
    const writes = fetcher.mock.calls.filter(([, args]) => args?.method === 'POST').map(([, args]) => JSON.parse(String(args!.body)));
    expect(writes).toEqual([{ action: 'remove_membership', user_id: 'manager', chat_id: -123 }]);
});
