import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach,expect,it,vi } from 'vitest';
import Picker from './VeoBusinessOrderPicker';
let view:ReactTestRenderer;const text=(v:any):string=>typeof v==='string'?v:(v?.children||[]).map(text).join('');
afterEach(async()=>{if(view)await act(async()=>view.unmount());vi.unstubAllGlobals();});
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
it('does not invent an order when Facebook returns no accessible notices',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({items:[],scan:{coverage:'No accessible notice'}}))));
    await act(async()=>{view=create(createElement(Picker,{contactId:'client',seller:'worker',closedDealId:'',dealMode:'new',onSaved:vi.fn()}));});
    await act(async()=>{await view.root.findByType('button').props.onClick();});expect(text(view.toJSON())).toContain('Meta may not expose every order');expect(view.root.findAllByType('select')).toHaveLength(0);
});
