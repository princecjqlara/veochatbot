import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ href, children }: any) => createElement('a', { href }, children) }));
import Details from './VeoReceiptSaleDetails';
let view: ReactTestRenderer;
const text = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(text).join('');
const contact = { id: 'client', page_id: 'page', name: 'Client', pipeline_stage: 'qualified' };
const order = { id: 'order', total_minor: 10000, paid_minor: 2000, currency: 'PHP' };
const commission = { target: 3, closed: 3, done: 2, rate: 35, totals: [{ currency: 'PHP', gross_minor: 20000, commission_minor: 7000 }], provisional: true };
const props = { contact, seller: 'worker', order, kind: 'done', version: 0, loading: false, onSaved: vi.fn() };
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('shows current lead stage, saved deal price, actual payments and remaining balance before upload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(commission))));
    await act(async () => { view = create(createElement(Details, props)); });
    const output = text(view.toJSON());
    expect(output).toContain('Current lead stage: Qualified'); expect(output).toContain('Total price:'); expect(output).toContain('Verified payments:'); expect(output).toContain('Remaining balance:');expect(output).toContain('Balance paid (PHP)');
    expect(view.root.findByProps({ name: 'amount' }).props.value).toBe('80.00');
    expect(view.root.findByProps({ name: 'confirmed' }).props.required).toBe(true);
    expect(view.root.findAllByProps({ name: 'confirm_converted' })).toHaveLength(0);
});
it('allows the Closed Deal receipt workflow without displaying a create-order or verified-payment form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(commission))));
    await act(async () => { view = create(createElement(Details, { ...props, order: null, kind: 'closed' })); });
    expect(text(view.toJSON())).toContain('No order is required for a Closed Deal'); expect(view.root.findAllByType('form')).toHaveLength(0);
});
it('shows both quota counts and both commission scenarios, keeping 35% when only one quota is reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(commission))));
    await act(async () => { view = create(createElement(Details, props)); });
    const output = text(view.toJSON()); expect(output).toContain('3 / 3'); expect(output).toContain('2 / 3'); expect(output).toContain('Quota not yet reached · 35%'); expect(output).toContain('Still needed: 0 Closed Deals and 1 Done Deals.'); expect(output).toContain('At 40% if both quotas are reached:'); expect(output).toContain('Provisional until Philippine midnight');
    await act(async () => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...commission, done: 3, rate: 40 })))); view.update(createElement(Details, { ...props, version: 1 })); });
    expect(text(view.toJSON())).toContain('Both quotas reached · 40%');
});
it('keeps the same request ID when retrying a balance payment after a lost response', async () => {
    const fetcher = vi.fn(async (_url: string, options?: any) => new Response(JSON.stringify(options?.method === 'POST' ? { error: 'Connection lost' } : commission), { status: options?.method === 'POST' ? 503 : 200 }));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('FormData', class { *[Symbol.iterator]() { yield ['kind', 'balance'];yield ['amount', '80.00'];yield ['occurred_at','2026-11-07T14:00'];yield ['reference','BANK-123'];yield ['confirmed','on']; } });
    await act(async () => { view = create(createElement(Details, props)); });
    const form = view.root.findByType('form');
    for (let i = 0; i < 2; i++) await act(async () => { await form.props.onSubmit({ preventDefault() {}, currentTarget: {} }); });
    const writes = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST').map(([, options]) => JSON.parse(options.body));
    expect(writes).toHaveLength(2); expect(writes[0]).toMatchObject({ action: 'payment', order_id: 'order', settle_done: true, amount: '80.00' }); expect(writes[0].request_id).toBe(writes[1].request_id); expect(props.onSaved).not.toHaveBeenCalled();
});
it('shows the total from the earlier Closed Deal plus balance paid as the input changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(commission))));
    await act(async () => { view = create(createElement(Details, { ...props, order: { ...order, paid_minor: 0 }, closedDeals: [{ id: 'cd',amount_minor: 4000,currency: 'PHP',occurred_at:'2026-11-06' }],closedDealId:'cd',dealMode:'existing' })); });
    expect(view.root.findByProps({ name:'amount' }).props.value).toBe('60.00');
    await act(async () => { view.root.findByProps({ name:'amount' }).props.onChange({target:{value:'61.00'}}); });
    expect(text(view.toJSON())).toContain('Difference: ₱1.00');expect(text(view.toJSON())).toContain('Total price: ₱100.00');
});
it('records an explicitly verified payment using Philippine payment time, then refreshes the chosen order', async () => {
    const fetcher = vi.fn(async (_url: string, options?: any) => new Response(JSON.stringify(options?.method === 'POST' ? { saved: { id: 'payment' } } : commission)));
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('FormData', class { *[Symbol.iterator]() { for (const entry of Object.entries({ kind: 'balance', amount: '80.00', occurred_at: '2026-11-07T14:00', reference: 'BANK-123', confirmed: 'on', confirm_converted: 'on' })) yield entry; } });
    await act(async () => { view = create(createElement(Details, props)); });
    await act(async () => { await view.root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: { reset() {} } }); });
    const write = JSON.parse(fetcher.mock.calls.find(([, options]) => options?.method === 'POST')![1].body);
    expect(write).toMatchObject({ action: 'payment', order_id: 'order', amount: '80.00', occurred_at: '2026-11-07T06:00:00.000Z', confirmed: true, confirm_converted: true }); expect(props.onSaved).toHaveBeenCalledWith('order');
});
it('does not show stale commission after changing seller when the new read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(commission))));
    await act(async () => { view = create(createElement(Details, props)); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })));
    await act(async () => { view.update(createElement(Details, { ...props, seller: 'other-worker' })); });
    expect(text(view.toJSON())).toContain('Commission unavailable: Forbidden'); expect(text(view.toJSON())).not.toContain('Quota not yet reached');
});
it('keeps commission estimates exact at cent boundaries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...commission, totals: [{ currency: 'PHP', gross_minor: 180, commission_minor: 63 }] }))));
    await act(async () => { view = create(createElement(Details, { ...props, order: { ...order, total_minor: 180, paid_minor: 0 } })); });
    const output = text(view.toJSON()); expect(output).toContain('At 35% if either quota is missed: ₱0.63'); expect(output).toContain('₱0.63 at 35%, or ₱0.72 at 40%');
});
