import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: any) => createElement('a', { href, ...props }, children) }));
import Operations from './VeoOperationsPanel';
import Calendar from './VeoWorkCalendar';
import Offboarding from './VeoStaffOffboarding';
const flatten = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(flatten).join('');
let view: ReactTestRenderer;
const scope = { user_id: 'worker', role: 'manager', launch_at: '2026-11-05T00:00:00Z' };
const salary = { user_id: 'worker', name: 'Selling Manager', active: true, work_date: '2026-11-06', qualified_closed: 1, qualified_done: 1, target: 1, rate: 40, provisional: true, totals: [{ currency: 'PHP', gross_minor: 203, commission_minor: 81 }] };
const record = { id: 'order', contact_id: 'client', page_id: 'page', contact_name: 'Previous Client', seller_name: 'Selling Manager', paid_minor: 203, total_minor: 203, balance_minor: 0, currency: 'PHP', converted: false, work_status: 'working', seller_active: true, done_at: '2026-11-06T01:00:00Z' };
const payload = () => ({ employees: [], summary: {}, finance: { days: [salary] }, orders: [record], order_page: { total: 1 }, page_rankings: [], client_assignments: [] });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T04:00:00Z')); });
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('shows actual daily commission and date-filtered clients, and blocks a paid but unconverted receipt', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(payload()))); vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(Operations, { scope, pages: [], busy: false, submit: vi.fn(), mode: 'salary' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const text = flatten(view.toJSON()); expect(text).toContain('Previous Client'); expect(text).toContain('0.81'); expect(text).toContain('40%'); expect(text).toContain('Provisional');
    await act(async () => view.root.findAllByType('button').find(b => flatten(b).includes('Payment, receipt'))!.props.onClick());
    const receipt = view.root.findAllByType('button').find(b => flatten(b).includes('Submit eligible receipt'))!;
    expect(receipt.props.disabled).toBe(true);
    expect(flatten(view.toJSON())).toContain('Confirm Converted lead');
    const from = view.root.findAllByType('input').find(i => i.props.type === 'date')!;
    await act(async () => from.props.onChange({ target: { value: '2026-11-05' } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(fetcher.mock.calls.some(([url]: any) => url.includes('from=2026-11-05'))).toBe(true);
});
it('keeps a removed seller receipt blocked even if settlement and conversion are complete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...payload(), orders: [{ ...record, converted: true, seller_active: false }] }))));
    await act(async () => { view = create(createElement(Operations, { scope, pages: [], busy: false, submit: vi.fn() })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    await act(async () => view.root.findAllByType('button').find(b => flatten(b).includes('Payment, receipt'))!.props.onClick());
    expect(view.root.findAllByType('button').find(b => flatten(b).includes('Submit eligible receipt'))!.props.disabled).toBe(true);
    expect(flatten(view.toJSON())).toContain('A supervisor must review attribution');
});
it('uses recorded salary in compact calendar cells and keeps missing ad costs unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ days: [{ work_date: '2026-11-06', closed: 1, done: 1, totals: salary.totals, spend: [], cash: [], provisional: true }], salary_days: [salary] }))));
    await act(async () => { view = create(createElement(Calendar, { scope: { ...scope, role: 'team_leader' }, pages: [] })); });
    const day = view.root.findAllByType('button').find(b => b.props['aria-label'] === 'Work date 2026-11-06')!;
    expect(day.props.className).toContain('min-h-[76px]'); expect(flatten(day)).toContain('0.81');
    expect(flatten(view.toJSON())).toContain('Unavailable without ad-spend coverage');
});
it.each(['member', 'manager'])('does not request calendar data for a %s', async role => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(Calendar, { scope: { ...scope, role }, pages: [] })); });
    expect(fetcher).not.toHaveBeenCalled(); expect(flatten(view.toJSON())).toContain('restricted');
});
it.each([['manager', ['member']], ['team_leader', ['manager', 'member']], ['owner', ['leader', 'manager', 'member']]])('limits %s removal choices to lower roles', async (role, expected) => {
    const accounts = [{ id: 'owner', role: 'owner' }, { id: 'leader', role: 'team_leader' }, { id: 'manager', role: 'manager' }, { id: 'member', role: 'member' }, { id: 'removed', role: 'member', active: false }];
    await act(async () => { view = create(createElement(Offboarding, { scope: { ...scope, user_id: 'self', role }, accounts, busy: false, submit: vi.fn() })); });
    expect(view.root.findAllByType('option').map(o => o.props.value).filter(Boolean)).toEqual(expected);
});
