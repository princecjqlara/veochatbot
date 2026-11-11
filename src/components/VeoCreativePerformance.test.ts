import {createElement} from 'react';
import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('./VeoAdsConnection',()=>({default:()=>null}));
import Creative from './VeoCreativePerformance';
let view:ReactTestRenderer;
const report=(name:string)=>({ads:[{ad_id:'1',ad:{ad_name:name},finance:[],demographics:[]}],daily:[],coverage:{}});
afterEach(async()=>{if(view)await act(async()=>view.unmount());vi.unstubAllGlobals();vi.useRealTimers();});
it('automatically loads a Page with recorded creatives when the overall report shows All Pages',async()=>{
 const pages=[{id:'A',name:'Quiet Page'},{id:'B',name:'Ads Page',has_ads:true},{id:'C',name:'Another Page',has_ads:true}];
 const fetcher=vi.fn(async(url:string)=>Response.json(report(new URL(url,'https://veo.test').searchParams.get('pageId')==='B'?'Ads from B':'Ads from C')));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Creative,{query:'range=7',pages}));});
 expect(fetcher.mock.calls[0][0]).toContain('pageId=B');expect(JSON.stringify(view.toJSON())).toContain('Ads from B');
 const select=()=>view.root.findByProps({'aria-label':'Creative chart Page'});expect(select().props.value).toBe('B');expect(select().findAllByType('option')).toHaveLength(3);
 await act(async()=>select().props.onChange({target:{value:'C'}}));expect(JSON.stringify(view.toJSON())).toContain('Ads from C');
 await act(async()=>view.update(createElement(Creative,{query:'range=7',pages:pages.slice(0,2)})));expect(select().props.value).toBe('B');expect(JSON.stringify(view.toJSON())).toContain('Ads from B');
});
it('loads creative data hourly while retaining the selected Page and dates',async()=>{
 vi.useFakeTimers();vi.stubGlobal('document',Object.assign(new EventTarget(),{hidden:false}));vi.stubGlobal('window',new EventTarget());
 const fetcher=vi.fn(async()=>Response.json(report('Saved creative')));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Creative,{query:'pageId=A&range=7'}));});
 await act(async()=>{await vi.advanceTimersByTimeAsync(59*60000);});expect(fetcher).toHaveBeenCalledTimes(1);
 await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});expect(fetcher).toHaveBeenCalledTimes(2);
});
it('rejects a late response from a previous Page even if the transport ignores abort',async()=>{
 let finish!:(value:Response)=>void;vi.stubGlobal('fetch',vi.fn((url:string)=>url.includes('pageId=A')?new Promise<Response>(resolve=>{finish=resolve;}):Promise.resolve(Response.json(report('Current B')))));
 await act(async()=>{view=create(createElement(Creative,{query:'pageId=A&range=7'}));});
 await act(async()=>{view.update(createElement(Creative,{query:'pageId=B&range=7'}));});expect(JSON.stringify(view.toJSON())).toContain('Current B');
 await act(async()=>{finish(Response.json(report('Previous A')));});expect(JSON.stringify(view.toJSON())).not.toContain('Previous A');expect(JSON.stringify(view.toJSON())).toContain('Current B');
});
it('does not leave all-Page selection stuck in a loading state or retain another Page data after denial',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json(report('Previous A'))));
 await act(async()=>{view=create(createElement(Creative,{query:'pageId=A&range=7'}));});
 await act(async()=>{view.update(createElement(Creative,{query:'pageId=all&range=7'}));});expect(JSON.stringify(view.toJSON())).not.toContain('Loading creative performance');expect(JSON.stringify(view.toJSON())).not.toContain('Previous A');
});
