import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ href, children }: any) => createElement('a', { href }, children) }));
import Receipts from './VeoReceiptInbox';
import Warnings from './VeoStaffWarnings';
import Creative from './VeoCreativePerformance';
let view: ReactTestRenderer;
const text = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(text).join('');
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); });
it('shows receipt holds and rechecks them without recording payment or changing a lead stage', async () => {
    const receipt = { id: 'r', contact_id: 'c', page_id: 'p', contact_name: 'Held client', seller_name: 'Seller', receipt_kind: 'done', salary_status: 'on_hold', salary_holds: ['converted_lead_required', 'verify_full_payment'], holds: [], delivery_status: 'on_hold', order_id: 'order', order_options: [], currency: 'PHP', total_minor: 10000, paid_minor: 2000 };
    const fetcher = vi.fn(async (_url: string, options: any) => new Response(JSON.stringify(options?.method === 'POST' ? { ...receipt, holds: receipt.salary_holds } : { items: [receipt], total: 1 }))); vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(Receipts, { scope: { user_id: 'u', role: 'member', launch_at: '2026-11-05' }, accounts: [], compact: true })); });
    expect(text(view.toJSON())).toContain('ON HOLD'); expect(text(view.toJSON())).toContain('Set the contact lead stage to Converted');
    await act(async () => { await view.root.findAllByType('button').find(b => text(b).includes('Recheck receipt and salary'))!.props.onClick(); });
    const writes = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST'); expect(writes).toHaveLength(1); expect(JSON.parse(writes[0][1].body).action).toBe('recheck');
});
it('shows current warnings, overdue explanation and a link to the existing Telegram poll', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ as_of: '2026-11-07T00:00:00Z', tomorrow: '2026-11-08', workers: [{ id: 'u', name: 'Employee', role: 'member', active: true, active_tomorrow: null, poll: { poll_id: 'p', poll_url: 'https://t.me/c/123/99' }, warnings: [{ key: 'o', kind: 'overdue_without_reason', title: 'Project is overdue without an explanation', severity: 'warning', overdue_hours: 4 }] }] }))));
    await act(async () => { view = create(createElement(Warnings)); });
    expect(text(view.toJSON())).toContain('1 warnings'); expect(text(view.toJSON())).toContain('4 hours overdue'); expect(view.root.findByProps({ href: 'https://t.me/c/123/99' })).toBeTruthy();
});
it('renders creative profit and cohort trends with demographics and explicit frequency coverage', async () => {
    const f = { currency: 'PHP', gross_minor: 10000, salary_minor: 4000, ad_spend_minor: 3000, net_minor: 3000, net_roas: 2, completed_order_gross_minor: 10000, spend_complete: true, average_daily_spend_minor: 3000, average_order_minor: 10000, cost_per_purchase_minor: 3000, cost_per_acquisition_minor: 3000 };
    const ad = { ad_id: '1', ad: { ad_name: 'Creative' }, inquiries: 2, converted: 1, conversion_rate: .5, finance: [f], demographics: [{ key: 'industry', total: 2, rows: [{ label: 'Food', count: 1, percent: .5 }] }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ads: [ad], daily: [{ ...ad, day: '2026-11-06' }], coverage: {} }))));
    await act(async () => { view = create(createElement(Creative, { query: 'pageId=page&range=7' })); });
    expect(text(view.toJSON())).toContain('Net profit after salary and ads'); expect(text(view.toJSON())).toContain('Food: 1 (50.0%)'); expect(view.root.findByProps({ 'aria-label': 'Daily creative performance chart' })).toBeTruthy();
});
