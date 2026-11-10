import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach,expect,it,vi } from 'vitest';
import Picker from './VeoBusinessOrderPicker';
let view:ReactTestRenderer;const text=(v:any):string=>typeof v==='string'?v:(v?.children||[]).map(text).join('');
afterEach(async()=>{if(view)await act(async()=>view.unmount());vi.useRealTimers();vi.unstubAllGlobals();});
it('fetches Facebook orders and links the selected source without submitting a typed total',async()=>{
    const saved=vi.fn(),source={id:'source',invoice_id:'123',total_minor:10000,currency:'PHP',observed_at:new Date().toISOString()};
    const fetcher=vi.fn(async(url:string,options?:any)=>new Response(JSON.stringify(url==='/api/workspace'?{saved:{id:'order'}}:{items:[source],business_suite_url:'https://business.facebook.com/latest/inbox/all?asset_id=123',scan:{coverage:'Available order notices checked'}})));vi.stubGlobal('fetch',fetcher);
    await act(async()=>{view=create(createElement(Picker,{contactId:'client',seller:'worker',closedDealId:'closed',dealMode:'existing',onSaved:saved}));});
    await act(async()=>{await view.root.findAllByType('button').find(b=>text(b)==='Fetch Facebook orders')!.props.onClick();});
    await act(async()=>{view.root.findByType('select').props.onChange({target:{value:'source'}});});
    expect(text(view.toJSON())).toContain('Total price from Facebook:');
    await act(async()=>{await view.root.findAllByType('button').find(b=>text(b)==='Use this Facebook order')!.props.onClick();});
    const payload=JSON.parse(fetcher.mock.calls.find(([url])=>url==='/api/workspace')![1].body);expect(payload).toEqual({action:'import_business_order',business_order_id:'source',seller_id:'worker',deal_mode:'existing',closed_deal_id:'closed'});expect(saved).toHaveBeenCalledWith('order');
});
const orderNotice = { id: 'invoice', invoice_id: '123', total_minor: 10000, currency: 'PHP', observed_at: '2026-11-10T12:00:00Z' };
const props = { contactId: 'client', seller: 'worker', closedDealId: '', dealMode: 'new' as const, onSaved: vi.fn() };
const fetchButton = () => view.root.findAllByType('button').find(button => text(button) === 'Fetch Facebook orders')!;
it('handles the deployed queued response without expecting an immediate scan and polls read-only results until ready', async () => {
    vi.useFakeTimers(); let posted = false, reads = 0;
    const fetcher = vi.fn(async (_url: string, options?: any) => {
        if (options?.method === 'POST') { posted = true; return Response.json({ queued: true, items: [], source: { sync: { status: 'pending' } } }); }
        if (!posted) return Response.json({ items: [], source: { sync: null } });
        return Response.json(++reads === 1 ? { items: [], source: { sync: { status: 'processing' } } } : { items: [orderNotice], source: { sync: { status: 'idle' } } });
    }); vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(Picker, props)); }); await act(async () => fetchButton().props.onClick());
    expect(text(view.toJSON())).toContain('refresh queued or running'); expect(text(view.toJSON())).not.toContain('Create the order in Business Suite, then fetch again. Meta');
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(view.root.findByType('select').findAllByType('option')).toHaveLength(2); expect(text(view.toJSON())).toContain('Saved Facebook orders loaded');
    const count = fetcher.mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(30000); }); expect(fetcher).toHaveBeenCalledTimes(count);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
it('keeps cached orders usable when a refresh is queued instead of reading a missing scan property', async () => {
    vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn(async (_url, options) => Response.json({ items: [orderNotice], ...(options?.method === 'POST' ? { queued: true } : {}), source: { sync: { status: options?.method === 'POST' ? 'pending' : 'idle' } } })));
    await act(async () => { view = create(createElement(Picker, props)); }); await act(async () => fetchButton().props.onClick());
    expect(text(view.toJSON())).toContain('refresh queued or running'); expect(text(view.toJSON())).not.toContain('Cannot read'); expect(view.root.findAllByType('option')).toHaveLength(2);
});
it('retries failed progress reads without posting another refresh or losing saved order choices', async () => {
    vi.useFakeTimers(); let reads = 0; const fetcher = vi.fn(async (_url: string, _options?: any) => ++reads === 2 ? Response.json({ error: 'Progress unavailable' }, { status: 503 }) : Response.json({ items: [orderNotice], source: { sync: { status: reads > 2 ? 'idle' : 'pending' } } })); vi.stubGlobal('fetch', fetcher);
    await act(async () => { view = create(createElement(Picker, props)); }); await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(text(view.toJSON())).toContain('checked again'); expect(view.root.findAllByType('option')).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(text(view.toJSON())).toContain('Saved Facebook orders loaded');
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
it('ignores a late initial list after a newer queued refresh completes', async () => {
    vi.useFakeTimers(); let first!: (response: Response) => void; let reads = 0;
    vi.stubGlobal('fetch', vi.fn((_url, options) => options?.method === 'POST' ? Response.json({ queued: true, items: [orderNotice], source: { sync: { status: 'pending' } } }) : ++reads === 1 ? new Promise<Response>(resolve => { first = resolve; }) : Response.json({ items: [orderNotice], source: { sync: { status: 'idle' } } })));
    await act(async () => { view = create(createElement(Picker, props)); }); await act(async () => fetchButton().props.onClick());
    await act(async () => first(Response.json({ items: [], source: { sync: null } }))); expect(view.root.findAllByType('option')).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(text(view.toJSON())).toContain('Saved Facebook orders loaded');
});
it('cancels the previous client’s progress reads when switching clients', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined, finish!: (response: Response) => void, reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: any) => url.includes('contact_id=second') ? Response.json({ items: [], source: { sync: null } }) : ++reads === 1 ? Response.json({ items: [], source: { sync: { status: 'pending' } } }) : new Promise<Response>(resolve => { signal = options.signal; finish = resolve; })));
    await act(async () => { view = create(createElement(Picker, props)); }); await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => view.update(createElement(Picker, { ...props, contactId: 'second' }))); expect(signal?.aborted).toBe(true);
    await act(async () => finish(Response.json({ items: [orderNotice], source: { sync: { status: 'idle' } } }))); expect(view.root.findAllByType('select')).toHaveLength(0);
});
it('does not invent an order when Facebook returns no accessible notices',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({items:[],scan:{coverage:'No accessible notice'}}))));
    await act(async()=>{view=create(createElement(Picker,{contactId:'client',seller:'worker',closedDealId:'',dealMode:'new',onSaved:vi.fn()}));});
    await act(async()=>{await view.root.findByType('button').props.onClick();});expect(text(view.toJSON())).toContain('Meta may not expose every order');expect(view.root.findAllByType('select')).toHaveLength(0);
});
