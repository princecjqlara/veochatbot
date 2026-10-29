import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import PipelinePage from './page';

afterEach(()=>{vi.unstubAllGlobals();});
it('shows saved partial answers as incomplete and filters clients without changing their bot status',async()=>{
    const requests:string[]=[];
    vi.stubGlobal('window',{setTimeout,clearTimeout,location:{search:'?pageId=page&details=with_details'}});
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
        requests.push(url);
        return new Response(JSON.stringify(url==='/api/pages'?{pages:[{id:'page',name:'SAMA KANA MEDIA'}]}:{
            contacts:[{id:'client',psid:'123',name:'Partial Client',pipeline_stage:'collecting_details',pipeline_stage_source:'chatbot',pipeline_stage_updated_at:'2026-10-21T08:00:00Z',
                chatbot_state:{status:'active',collected_details:{'Business Name':'Cafe'},missing_details:[],updated_at:'2026-10-21T08:00:00Z'},
                detail_progress:{collected_details:{'Business Name':'Cafe'},saved_count:1,collected_count:1,required_count:8,missing_details:['Contact Number','Preferred Style'],complete:false}}],
            total:1,stageCounts:{new:5,engaged:2,collecting_details:1,qualified:0,order_created:0,converted:0,not_qualified:0,opted_out:0}
        }),{status:200});
    }));
    let view!:ReactTestRenderer;
    await act(async()=>{view=create(createElement(PipelinePage));});
    const content=JSON.stringify(view.toJSON());
    expect(content).toContain('Form incomplete');expect(content).not.toContain('Form complete');
    expect(content).toContain('Cafe');expect(content).toContain('1 / 8 details saved');
    expect(requests.some(url=>url.includes('details=with_details'))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.every(call=>!call[1]?.method)).toBe(true);
    await act(async()=>view.unmount());
});

it('immediately marks a manually changed Not Qualified lead poor and clears it when corrected',async()=>{
    let stage='new';
    vi.stubGlobal('window',{setTimeout,clearTimeout,location:{search:'?pageId=page'}});
    vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
        if(url==='/api/pages')return new Response(JSON.stringify({pages:[{id:'page',name:'SAMA KANA MEDIA'}]}));
        if(options?.method==='PATCH'){stage=JSON.parse(String(options.body)).stage;return new Response(JSON.stringify({success:true,stage}));}
        return new Response(JSON.stringify({contacts:[{id:'client',psid:'123',name:'Synthetic Client',pipeline_stage:stage,pipeline_stage_source:'manual',pipeline_stage_updated_at:'2026-10-29T00:00:00Z',chatbot_state:null,detail_progress:{collected_details:{},saved_count:0,collected_count:0,required_count:0,missing_details:[],complete:false}}],total:1,stageCounts:{[stage]:1}}));
    }));
    let view!:ReactTestRenderer;await act(async()=>{view=create(createElement(PipelinePage));});
    const select=()=>view.root.findAllByType('select').find(s=>s.findAllByType('option').some(o=>o.props.value==='not_qualified')&&s.props.value===stage)!;
    await act(async()=>select().props.onChange({target:{value:'not_qualified'}}));expect(JSON.stringify(view.toJSON())).toContain('Poor lead quality');
    await act(async()=>select().props.onChange({target:{value:'qualified'}}));expect(JSON.stringify(view.toJSON())).toContain('Good lead quality');expect(JSON.stringify(view.toJSON())).not.toContain('Poor lead quality');
    await act(async()=>view.unmount());
});
