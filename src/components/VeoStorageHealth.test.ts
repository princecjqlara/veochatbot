import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
import Health from './VeoStorageHealth';
let view: ReactTestRenderer;
afterEach(async () => { if (view) await act(async () => view.unmount());vi.unstubAllGlobals(); });
it('keeps a healthy compact check quiet while making critical or stale storage visible', async () => {
    let healthy = true;vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: healthy ? 'healthy' : 'critical', maintenance_healthy: true, metrics_fresh: healthy, optional_work_paused: !healthy, database_bytes: 89000000, database_budget_bytes: 500000000, disk_size_bytes: 2000000000, disk_available_bytes: healthy ? 1500000000 : 200000000 })));
    await act(async () => { view = create(createElement(Health, { compact: true })); });expect(view.toJSON()).toBeNull();
    healthy = false;await act(async () => view.update(createElement(Health, { compact: false })));
    await act(async () => view.root.findByType('button').props.onClick());
    const text = JSON.stringify(view.toJSON());expect(text).toContain('needs attention');expect(text).toContain('paused');expect(text).toContain('stale');
});
it('shows failed monitoring explicitly instead of a healthy storage claim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'offline' }, { status: 503 })));
    await act(async () => { view = create(createElement(Health, { compact: true })); });expect(view.root.findByProps({ role: 'alert' })).toBeTruthy();
});
