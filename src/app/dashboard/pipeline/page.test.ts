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
