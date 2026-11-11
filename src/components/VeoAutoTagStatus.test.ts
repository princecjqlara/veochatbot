import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import Status from './VeoAutoTagStatus';
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
let view: ReactTestRenderer;
const flatten = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(flatten).join('');
afterEach(async () => { if (view) await act(async () => view.unmount());vi.unstubAllGlobals(); });
it('distinguishes failed, disabled, pending, stale and successful Pages without showing missing scans as healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ pages: [
        { page_id: 'one', name: 'Failed', enabled: true, last_error: 'PAGE_RECONNECT_REQUIRED' },
        { page_id: 'two', name: 'Pending', enabled: true }, { page_id: 'three', name: 'Disabled', enabled: false },
        { page_id: 'four', name: 'Current', enabled: true, last_success_at: new Date().toISOString() },
        { page_id: 'five', name: 'Overdue', enabled: true, last_success_at: '2026-01-01T00:00:00Z' }
    ] })));
    await act(async () => { view = create(createElement(Status)); });const text = flatten(view.toJSON());
    for (const message of ['Refresh Facebook permissions', 'Waiting for first scan', 'Disabled in settings', 'Recent scan successful', 'Scan is overdue', 'Meta may omit']) expect(text).toContain(message);
});
it('surfaces failed status reads and lets the user recheck', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Status unavailable' }, { status: 503 })).mockResolvedValueOnce(Response.json({ pages: [] }));vi.stubGlobal('fetch', fetch);
    await act(async () => { view = create(createElement(Status)); });expect(flatten(view.toJSON())).toContain('Status unavailable');
    await act(async () => view.root.findByType('button').props.onClick());expect(flatten(view.toJSON())).not.toContain('Status unavailable');expect(fetch).toHaveBeenCalledTimes(2);
});
