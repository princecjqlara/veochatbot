import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ href, children }: any) => createElement('a', { href }, children) }));
vi.mock('./VeoReceiptSaleDetails', () => ({ default: () => null }));
import Inbox from './VeoReceiptInbox';
import Details from './VeoReceiptSaleDetails';
let view: ReactTestRenderer;
const scope={user_id:'seller',role:'member',launch_at:'2026-11-09'};
const accounts=[{id:'seller',name:'Seller',role:'member'}];
const order={id:'order',seller_id:'seller',description:'Invoice 123',total_minor:10000,currency:'PHP',done_at:null};
const text=(node:any):string=>typeof node==='string'?node:(node?.children||[]).map(text).join('');
async function mount(closed_deals:any[]=[]){
    const fetcher=vi.fn(async (url:string,_options?:RequestInit)=>new Response(JSON.stringify(url.startsWith('/api/workspace?')
        ? {contact:{id:'client',name:'Client'},orders:[order],closed_deals,payments:[]}
        : {items:[],total:0})));
    vi.stubGlobal('fetch',fetcher);
    await act(async()=>{view=create(createElement(Inbox,{scope,accounts,initialContactId:'client'}));});
    return fetcher;
}
afterEach(async()=>{if(view)await act(async()=>view.unmount());vi.unstubAllGlobals();});
it('shows order selection for Closed Deal and keeps receipt submission blocked until the order is checked',async()=>{
    const fetcher=await mount();
    expect(view.root.findByType(Details).props.kind).toBe('closed');
    const label=view.root.findAllByType('label').find(node=>text(node).startsWith('Order / total price'))!;
    expect(label).toBeDefined();
    const check=view.root.findAllByType('button').find(node=>text(node).includes('Check saved requirements'))!;
    expect(check.props.disabled).toBe(true);
    await act(async()=>{label.findByType('select').props.onChange({target:{value:'order'}});});
    expect(view.root.findByType(Details).props.order.id).toBe('order');
    expect(check.props.disabled).toBe(false);
    expect(fetcher.mock.calls.every(([,options])=>!options?.method)).toBe(true);
});
it('completes an existing Closed Deal using its same locked order and preserves the down payment',async()=>{
    const closed={id:'closed',seller_id:'seller',order_id:'order',amount_minor:4000,currency:'PHP',occurred_at:'2026-11-10'};
    await mount([closed]);
    const complete=view.root.findAllByType('button').find(node=>text(node)==='Turn this Closed Deal into Done Deal')!;
    await act(async()=>{complete.props.onClick();});
    expect(view.root.findByType(Details).props).toMatchObject({kind:'done',order:{id:'order'},closedDealId:'closed',closedDeals:[closed],dealMode:'existing'});
    const label=view.root.findAllByType('label').find(node=>text(node).startsWith('Order / total price'))!;
    expect(label.findByType('select').props).toMatchObject({value:'order',disabled:true});
});
