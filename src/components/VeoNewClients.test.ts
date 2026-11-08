import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ href, children }: any) => createElement('a', { href }, children) }));
import Clients from './VeoNewClients';
let view: ReactTestRenderer;
const text = (v: any): string => typeof v === 'string' || typeof v === 'number' ? String(v) : (v?.children || []).map(text).join('');
const scope = { user_id: 'worker', role: 'member' };
const item = { id: 'client', page_id: 'page', name: 'New client', page_name: 'VEO Page', pipeline_stage: 'qualified', owner_id: null, can_offer: false };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { if (view) await act(async () => view.unmount());vi.useRealTimers();vi.unstubAllGlobals(); });
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); }
it('requires Ready before enabling Accept, then makes Busy explicit after acceptance', async () => {
    let ready = false;
    const fetcher = vi.fn(async (_url: string, options?: any) => {
        if (options?.method === 'POST') { const b = JSON.parse(options.body);ready = b.action === 'readiness' && b.status === 'ready';return new Response(JSON.stringify({ saved: {} })); }
        return new Response(JSON.stringify({ items: [item], roster: [], readiness: { ready, expires_at: new Date(Date.now() + 1800000).toISOString() }, total: 1 }));
    });vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(Clients, { scope, pages: [] })); });await tick();
    const accept = () => view.root.findAllByType('button').find(b => text(b) === 'Accept client')!;
    expect(accept().props.disabled).toBe(true);
    await act(async () => { view.root.findAllByType('button').find(b => text(b) === 'Ready')!.props.onClick(); });await tick();
    expect(accept().props.disabled).toBe(false);
    await act(async () => { accept().props.onClick(); });await tick();
    expect(text(view.toJSON())).toContain('Client accepted. Your status is now Busy');
    const writes = fetcher.mock.calls.filter(([, o]) => o?.method === 'POST').map(([, o]) => JSON.parse(o.body));
    expect(writes.map(b => b.action)).toEqual(['readiness', 'accept']);expect(writes.every(b => b.request_id)).toBe(true);
});
it('gives Owner assignment controls without personal Ready buttons and filters recipient choices by Ready and Page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ ...item, owner_id: 'old', can_offer: true }], readiness: { ready: false }, roster: [
        { id: 'ready', name: 'Ready worker', role: 'member', ready: true, page_ids: ['page'] },
        { id: 'busy', name: 'Busy worker', role: 'member', ready: false, page_ids: ['page'] },
        { id: 'wrong-page', name: 'Other Page worker', role: 'member', ready: true, page_ids: ['other'] }
    ], total: 1 }))));
    await act(async () => { view = create(createElement(Clients, { scope: { user_id: 'owner', role: 'owner' }, pages: [] })); });await tick();
    expect(view.root.findAllByType('button').some(b => text(b) === 'Ready' || text(b) === 'Busy')).toBe(false);
    const select = view.root.findAllByType('select').find(s => s.findAllByType('option').some(o => o.props.value === 'ready'))!;
    expect(select.findAllByType('option').map(o => o.props.value)).toEqual(['', 'ready']);
    expect(view.root.findByProps({ name: 'reason' }).props.required).toBe(true);
});
it('shows assigned offers and acceptance expiry with decline and refresh actions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ ...item, offer_id: 'offer', offered_to: 'worker', offered_to_name: 'Worker', offer_expires_at: new Date().toISOString(), offer_authorized: false }], readiness: { ready: true }, roster: [], total: 1 }))));
    await act(async () => { view = create(createElement(Clients, { scope, pages: [] })); });await tick();
    expect(text(view.toJSON())).toContain('Access or assignment changed');
    expect(view.root.findAllByType('button').find(b => text(b) === 'Accept offered client')!.props.disabled).toBe(true);
    expect(view.root.findAllByType('button').some(b => text(b) === 'Decline')).toBe(true);
});
it('keeps an automatic inquiry reserved for the timed editor offer even while the viewer is Ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ ...item, auto_assignment: { status: 'waiting', eligible_at: new Date(Date.now() + 3600000).toISOString() } }],
        roster: [], readiness: { ready: true }, total: 1, auto_policy: { enabled: true, wait_minutes: 60, accept_minutes: 15, wait_anchor: 'inquiry' } }))));
    await act(async () => { view = create(createElement(Clients, { scope, pages: [] })); });await tick();
    expect(view.root.findAllByType('button').find(b => text(b) === 'Waiting for automatic editor offer')!.props.disabled).toBe(true);
    expect(text(view.toJSON())).toContain('Automatic editor offers start after 60 minutes');
    expect(text(view.toJSON())).toContain('15 minutes to accept');
});
it('sends a handover offer and keeps the current worker shown until the recipient accepts', async () => {
    let offered = false;
    const fetcher = vi.fn(async (_url: string, options?: any) => {
        if (options?.method === 'POST') { offered = true;return new Response(JSON.stringify({ saved: {} })); }
        return new Response(JSON.stringify({ readiness: { ready: false }, total: 1,
            items: [{ ...item, owner_id: 'current', owner_name: 'Current Worker', can_offer: true,
                ...(offered ? { offer_id: 'handover-offer', offered_to: 'next', offered_to_name: 'Next Worker', offer_authorized: true } : {}) }],
            roster: [{ id: 'next', name: 'Next Worker', role: 'member', ready: true, page_ids: ['page'] }] }));
    });vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(Clients, { scope: { user_id: 'leader', role: 'team_leader' }, pages: [] })); });await tick();
    await act(async () => view.root.findAllByType('button').find(b => text(b) === 'Assigned clients / Handovers')!.props.onClick());await tick();
    const recipient = view.root.findAllByType('select').find(s => s.findAllByType('option').some(o => o.props.value === 'next'))!;
    await act(async () => recipient.props.onChange({ target: { value: 'next' } }));
    expect(view.root.findByProps({ name: 'reason' }).props.required).toBe(true);
    vi.stubGlobal('FormData', class { get() { return 'Next shift takes over'; } });
    await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {}, currentTarget: { reset() {} } }));await tick();
    const writes = fetcher.mock.calls.filter(([, o]) => o?.method === 'POST').map(([, o]) => JSON.parse(o.body));
    expect(writes).toEqual([{ action: 'offer', contact_id: 'client', user_id: 'next', reason: 'Next shift takes over', request_id: expect.any(String) }]);
    expect(text(view.toJSON())).toContain('Assigned to: Current Worker');
    expect(text(view.toJSON())).toContain('Offered to Next Worker');
    expect(text(view.toJSON())).toContain('does not create a Closed Deal, Done Deal or commission');
});
