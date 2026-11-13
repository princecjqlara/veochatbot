import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ children }: any) => children }));
vi.mock('./VeoAdsConnection', () => ({ default: () => null }));
vi.mock('@/lib/use-hourly-report-refresh', () => ({ useHourlyReportRefresh: () => {} }));
import Calendar from './VeoWorkCalendar';
let view: ReactTestRenderer;
const text = (v: any): string => Array.isArray(v) ? v.map(text).join('') : typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(text).join('');
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('renders inquiry-date sales and clear red/green colors even when daily transactions have different results', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));
    const day = (date: string, net: number) => ({ work_date: date, future: false, inquiries: 10, closed: 0, done: 0, cohort_closed: 3, cohort_done: 3, cohort_orders_created: 3,
        cohort_finance: [{ currency: 'PHP', net_minor: net, received_minor: 100000, salary_minor: 40000, ad_spend_minor: 60000 - net }],
        finance: [{ currency: 'PHP', net_minor: -net, gross_minor: 0, salary_minor: 0, ad_spend_minor: 1000 }], salary_rates: [], created_orders: { count: 0 } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ month: '2026-11', selected_day: '2026-11-14', days: [day('2026-11-11', -1000), day('2026-11-12', 1000), { ...day('2026-11-13', 60000), cohort_finance: [{ currency: 'PHP', net_minor: 60000, received_minor: 100000, salary_minor: 40000, ad_spend_minor: 0, spend_usable: true }] }], selected: { future: true, cohort: {} }, pages: [] })));
    await act(async () => { view = create(createElement(Calendar, { scope: { role: 'owner' }, pages: [] })); });
    const loss = view.root.findByProps({ 'aria-label': 'Work date 2026-11-11' });
    const profit = view.root.findByProps({ 'aria-label': 'Work date 2026-11-12' });
    expect(loss.props.style.backgroundColor).toContain('hsl(0 ');
    expect(profit.props.style.backgroundColor).toContain('hsl(140 ');
    expect(text(loss)).toContain('CD 3'); expect(text(loss)).toContain('DD 3'); expect(text(loss)).toContain('Sales received');
    expect(text(profit)).toContain('Profit');
    const noSpend=view.root.findByProps({'aria-label':'Work date 2026-11-13'});expect(noSpend.props.style.backgroundColor).toBe('#ffffff');expect(text(noSpend)).toContain('No ad spend - no shading');expect(text(noSpend)).toContain('Profit');
    expect(view.root.findAllByType('option').some(o => o.props.value === 'net')).toBe(false);
});
