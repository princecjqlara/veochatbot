import {createElement} from 'react';
import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('./VeoAdsConnection',()=>({default:()=>null}));
import Creative from './VeoCreativePerformance';
let view:ReactTestRenderer;
const report=(name:string)=>({ads:[{ad_id:'1',ad:{ad_name:name},finance:[],demographics:[]}],daily:[],coverage:{}});
afterEach(async()=>{if(view)await act(async()=>view.unmount());vi.unstubAllGlobals();});
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
