import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import Page from './page';
let view: ReactTestRenderer;
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });
const history = (title: string) => ({ items: [{ id: title, sourceId: title, pageId: 'two', source: 'audit', kind: 'other', actionType: 'manual_review', title, status: 'completed', actor: null, targetCount: 1, successCount: 1, failureCount: 0, pendingCount: 0, createdAt: '2026-11-10T01:00:00Z', details: {} }], total: 1, team: [], summary: { targets: 1, succeeded: 1, failed: 0, pending: 0 }, auditEnabled: true });
it('does not replace the selected Page’s activity with a late response from the previous Page', async () => {
    vi.useFakeTimers(); vi.stubGlobal('window', { location: { search: '' }, setTimeout, clearTimeout });
    let finish!: (response: Response) => void, oldSignal: AbortSignal | undefined;
    const fetcher = vi.fn((path: string, options: any) => path === '/api/pages' ? Promise.resolve(Response.json({ pages: [{ id: 'one', name: 'Page One' }, { id: 'two', name: 'Page Two' }] })) : path.startsWith('/api/pages/one/history') ? (oldSignal = options.signal, new Promise<Response>(resolve => { finish = resolve; })) : Promise.resolve(Response.json(history('Current Page activity'))));
    vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(Page)); });
    const select = view.root.findAllByType('select').find(select => select.findAllByType('option').some(option => option.props.value === 'two'))!;
    await act(async () => select.props.onChange({ target: { value: 'two' } })); expect(oldSignal?.aborted).toBe(true);
    await act(async () => { finish(Response.json(history('Obsolete Page activity'))); });
    expect(JSON.stringify(view.toJSON())).toContain('Current Page activity'); expect(JSON.stringify(view.toJSON())).not.toContain('Obsolete Page activity');
});
