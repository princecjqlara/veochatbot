import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
vi.mock('./VeoEmployeeProfile', () => ({ default: () => null }));
vi.mock('./VeoStaffWarnings', () => ({ default: () => null }));
import Operations from './VeoOperationsPanel';
import Statement from './VeoSalaryStatement';
let view: ReactTestRenderer;
const text = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(text).join('');
const employee = { id: 'worker', name: 'Employee A', active: true, role: 'member', page_ids: [] };
function body(url: string) {
    const q = new URL(url, 'https://veo.test').searchParams, first = q.get('from') || '2026-11-01', last = q.get('to') || '2026-11-10';
    const days = []; for (let time = Date.parse(first); time <= Date.parse(last); time += 86400000) days.push({ user_id: 'worker', name: 'Employee A', active: true, work_date: new Date(time).toISOString().slice(0, 10), provisional: time === Date.parse('2026-11-10'), totals: [{ currency: 'PHP', gross_minor: 10000, commission_minor: 1000 }] });
    return { summary: {}, orders: [], order_page: { total: 0 }, finance: { days }, employees: [employee], client_assignments: [], telegram_sync: {} };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T09:00:00Z')); vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(body(url)))); });
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(role = 'owner') { await act(async () => { view = create(createElement(Operations, { scope: { user_id: 'worker', role, launch_at: '2026-11-01T00:00:00Z' }, pages: [], submit: vi.fn(), busy: false, mode: 'salary' })); }); await act(async () => { await vi.advanceTimersByTimeAsync(1); }); }
it.each(['owner', 'team_leader', 'manager', 'member'])('shows a salary statement and date filters for %s', async role => {
    await mount(role); expect(view.root.findByProps({ 'aria-label': 'Salary for selected dates' })).toBeDefined();
    expect(text(view.toJSON())).toContain('PHP 100.00'); expect(text(view.toJSON())).toContain('2026-11-01 to 2026-11-10, inclusive');
    if (role === 'member') expect(new URL(vi.mocked(fetch).mock.calls[0][0] as string, 'https://veo.test').searchParams.get('worker_id')).toBe('worker');
});
it('uses both selected endpoints, updates totals and keeps day-level details available', async () => {
    await mount();
    await act(async () => view.root.findByProps({ 'aria-label': 'Salary and performance to date' }).props.onChange({ target: { value: '2026-11-09' } }));
    await act(async () => view.root.findByProps({ 'aria-label': 'Salary and performance from date' }).props.onChange({ target: { value: '2026-11-05' } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(text(view.toJSON())).toContain('2026-11-05 to 2026-11-09, inclusive'); expect(text(view.toJSON())).toContain('PHP 50.00'); expect(text(view.toJSON())).toContain('Daily salary / calculated commission');
    const q = new URL(vi.mocked(fetch).mock.calls.at(-1)![0] as string, 'https://veo.test').searchParams; expect(q.get('from')).toBe('2026-11-05'); expect(q.get('to')).toBe('2026-11-09');
});
it('ignores a late response from the previous date range', async () => {
    let finish!: (value: Response) => void; const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockImplementation(async (url: string) => Response.json(body(url))); vi.stubGlobal('fetch', fetcher);
    await mount(); await act(async () => view.root.findByProps({ 'aria-label': 'Salary and performance from date' }).props.onChange({ target: { value: '2026-11-05' } })); await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => finish(Response.json(body('/api/workspace/operations?from=2026-11-01&to=2026-11-10'))));
    expect(text(view.toJSON())).toContain('PHP 60.00'); expect(text(view.toJSON())).not.toContain('PHP 100.00');
});
it('does not invent a salary for an empty verified ledger', async () => {
    await act(async () => { view = create(createElement(Statement, { days: [], from: '2026-11-01', to: '2026-11-10', role: 'owner', onEmployee: vi.fn() })); }); expect(text(view.toJSON())).toContain('No verified commission');
});
