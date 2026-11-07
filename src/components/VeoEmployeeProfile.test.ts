import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ href, children }: any) => createElement('a', { href }, children) }));
import Profile, { EmployeeProfileDetails } from './VeoEmployeeProfile';
import Operations from './VeoOperationsPanel';
const flatten = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(flatten).join('');
let view: ReactTestRenderer;
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); });
const fixture = (name = 'Employee A') => ({
    employee: { name, role: 'member', active: true, pages: [{ id: 'page', name: 'VEO Page' }], supervisor: 'Manager', telegram_username: 'employee', active_today: null, active_tomorrow: true },
    from: '2026-11-05', to: '2026-11-07', capacity: { target: 1, observed_max_done: 2, observed_max_closed: 3, best_days: [], peak_done_dates: [] },
    summary: { closed: 3, done: 2, cd_cohort_done: 2, cd_cohort: 3, cd_to_dd_rate: 2 / 3, cd_to_dd_hours_mean: 30, cd_to_dd_hours_median: 24, assigned_cohort: 5, assigned_cohort_converted: 2, conversion_rate: 0.4, reply_rate: null, reply_client_days: 0, answered_client_days: 0, unattributed_reply_client_days: 0, waiting_payment: 1, overdue: 0 },
    ranking: { rank: 2, peers: 4 }, ranking_scope: 'Your team', attendance: { active: 1, inactive: 0, unknown: 1 }, completed_days: 2, active_completed_days: 1,
    totals: [{ currency: 'PHP', gross_minor: 20000, net_minor: 20000, salary_minor: 8000, average_daily_gross_minor: 10000, average_daily_salary_minor: 4000, average_daily_net_minor: 10000, average_active_day_salary_minor: 8000, provisional_gross_minor: 0, provisional_salary_minor: 0 }],
    days: [{ work_date: '2026-11-05', attendance: { active: true, source: 'telegram' }, target: 1, closed: 3, done: 2, qualified_closed: 3, qualified_done: 2, rate: 40, totals: [], rank: 2, peers: 4, replies: { incoming_clients: 0, answered_clients: 0 } }],
    clients: [{ contact_id: 'client', page_id: 'page', name: 'Previous client', page_name: 'VEO Page', currently_assigned: false, closed: 1, done: 1 }], client_count: 1, reply_coverage: { complete: false, recent_window_provisional: true }, coverage: 'Verified since launch'
});
it('presents one profile with daily financial, capacity, rank, attendance and client history', async () => {
    await act(async () => { view = create(createElement(EmployeeProfileDetails, { data: fixture() })); });
    const text = flatten(view.toJSON());
    for (const label of ['Employee A', '1 CD + 1 DD', '2 DD / day', '66.7%', '1.3 days', '40.0%', 'Average daily salary', 'Average daily gross sales', 'zero-sales dates', '#2 / 4', 'Jaucian / Telegram', 'Unknown', '40%', 'Unattributed', 'Verified since launch']) {
        expect(text.toLowerCase()).toContain(label.toLowerCase());
    }
    expect(view.root.findByType('a').props.href).toBe('/dashboard/contacts/client?pageId=page');
    expect(text).toContain('Message capture is partial'); expect(text).toContain('Unavailable');
});
it('clears the previous employee while loading and ignores late responses after switching', async () => {
    let resolveFirst: (r: Response) => void = () => {};
    const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('worker_id=A') ? first : Promise.resolve(new Response(JSON.stringify(fixture('Employee B'))))));
    await act(async () => { view = create(createElement(Profile, { worker: 'A', from: '2026-11-05', to: '2026-11-07', page: '' })); });
    expect(flatten(view.toJSON())).toContain('Loading');
    await act(async () => { view.update(createElement(Profile, { worker: 'B', from: '2026-11-05', to: '2026-11-07', page: '' })); });
    expect(flatten(view.toJSON())).toContain('Employee B');
    await act(async () => { resolveFirst(new Response(JSON.stringify(fixture('Employee A')))); await first; });
    expect(flatten(view.toJSON())).not.toContain('Employee A');
});
it('shows a denied or failed profile as an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Employee access denied' }), { status: 403 })));
    await act(async () => { view = create(createElement(Profile, { worker: 'A', from: '2026-11-05', to: '2026-11-07', page: '' })); });
    expect(view.root.findByProps({ role: 'alert' }).children.join('')).toBe('Employee access denied');
});
it('shows zero daily averages explicitly when completed dates have no sales', async () => {
    await act(async () => { view = create(createElement(EmployeeProfileDetails, { data: { ...fixture(), totals: [] } })); });
    expect(flatten(view.toJSON())).toContain('Average daily salary: 0');
    expect(flatten(view.toJSON())).toContain('average daily gross sales: 0');
});
it('opens the unified profile from the employee ranking and keeps client filters on that employee', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T01:00:00Z'));
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('employee-profile') ? fixture() : {
        summary: {}, employees: [{ id: 'A', name: 'Employee A', closed: 3, done: 2, active: true, rank: 2 }], page_rankings: [], finance: { days: [] }, orders: [], order_page: { total: 0 }, client_assignments: []
    }))); vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(Operations, { scope: { role: 'owner', user_id: 'owner', launch_at: '2026-11-05T00:00:00Z' }, pages: [{ id: 'page', name: 'VEO Page' }], busy: false, submit: vi.fn() })); await vi.advanceTimersByTimeAsync(300); });
    await act(async () => { view.root.findAllByType('button').find(b => flatten(b) === 'Employee A')!.props.onClick(); });
    expect(view.root.findByProps({ 'aria-label': 'Unified employee profile' })).toBeTruthy();
    await act(async () => { view.root.findAllByType('button').find(b => flatten(b) === 'Closed Deals')!.props.onClick(); await vi.advanceTimersByTimeAsync(300); });
    const lastOperations = fetcher.mock.calls.map(c => c[0]).filter(u => u.startsWith('/api/workspace/operations')).at(-1)!;
    expect(lastOperations).toContain('worker_id=A'); expect(lastOperations).toContain('status=closed');
    await act(async () => { view.root.findAllByType('select').find(s => s.props.children?.[0]?.props?.children === 'All assigned Pages')!.props.onChange({ target: { value: 'page' } }); });
    expect(fetcher.mock.calls.some(([url]) => url.includes('employee-profile') && url.includes('worker_id=A') && url.includes('page_id=page'))).toBe(true);
});
