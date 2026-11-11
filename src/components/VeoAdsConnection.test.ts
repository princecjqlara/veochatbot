import {createElement} from 'react';
import {act,create,type ReactTestRenderer} from 'react-test-renderer';
import {afterEach,expect,it,vi} from 'vitest';
import Connection from './VeoAdsConnection';
let view:ReactTestRenderer;
const text=(v:any):string=>typeof v==='string'||typeof v==='number'?String(v):(v?.children||[]).map(text).join('');
const status=(extra:any={})=>({status:'connect_required',configured:true,can_manage:true,verified_inventory_ads:0,last_synced_at:null,message:'Page access is separate from ad read access.',...extra});
afterEach(async()=>{if(view)await act(async()=>view.unmount());vi.unstubAllGlobals();vi.useRealTimers();});
it('shows missing ads consent honestly and opens only the approved Meta OAuth address',async()=>{
 const assign=vi.fn();vi.stubGlobal('window',{location:{search:'',assign}});const fetcher=vi.fn(async(_url:string,options?:any)=>Response.json(options?.method==='POST'?{authorizationUrl:'https://www.facebook.com/v21.0/dialog/oauth?state=private'}:status()));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Connection));});expect(text(view.toJSON())).toContain('Not completed');expect(text(view.toJSON())).toContain('Verified Marketing API ads: 0');
 await act(async()=>{await view.root.findAllByType('button').find(node=>text(node)==='Connect Meta Ads')!.props.onClick();});expect(assign).toHaveBeenCalledWith(expect.stringContaining('https://www.facebook.com/'));
 expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST').map(([,options])=>JSON.parse(options.body).action)).toEqual(['authorize']);
});
it('automatically fetches once after successful ad consent and refreshes dependent reports',async()=>{
 vi.stubGlobal('window',{location:{search:'?view=budget&ads_connected=1',assign:vi.fn()}});const refreshed=vi.fn(),fetcher=vi.fn(async(_url:string,options?:any)=>Response.json(options?.method==='POST'?{complete:true,inventory_ads:12,accounts:2,coverage_days:105}:status({status:'connected'})));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Connection,{onRefreshed:refreshed}));});expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);expect(refreshed).toHaveBeenCalledTimes(1);expect(text(view.toJSON())).toContain('Fetched 12 verified ad entries');
});
it('automatically reuses saved Page access and fetches data once without redirecting to Facebook',async()=>{
 const assign=vi.fn();vi.stubGlobal('window',{location:{search:'',assign}});const refreshed=vi.fn();let connected=false;
 const fetcher=vi.fn(async(_url:string,options?:any)=>{if(options?.method==='POST'){const action=JSON.parse(options.body).action;if(action==='discover'){connected=true;return Response.json({connected:true,credential_origin:'connected_page',accounts:27});}return Response.json({complete:true,inventory_ads:20,accounts:27});}return Response.json(status({status:connected?'connected':'connect_required',can_reuse_page_access:!connected}));});vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Connection,{onRefreshed:refreshed}));});
 expect(fetcher.mock.calls.filter(([,o])=>o?.method==='POST').map(([,o])=>JSON.parse(o.body).action)).toEqual(['discover','refresh']);expect(refreshed).toHaveBeenCalledOnce();expect(assign).not.toHaveBeenCalled();
});
it('consumes the authorization-return flag so reopening the report does not repeat the initial source fetch',async()=>{
 const location={search:'?view=budget&ads_connected=1',href:'https://veo.test/dashboard/workspace?view=budget&ads_connected=1',assign:vi.fn()},replaceState=vi.fn((_state:any,_title:any,url:string)=>{location.href=url;location.search=new URL(url).search;});
 vi.stubGlobal('window',{location,history:{replaceState}});const fetcher=vi.fn(async(_url:string,options?:any)=>Response.json(options?.method==='POST'?{complete:true,inventory_ads:12,accounts:2,coverage_days:105}:status({status:'connected'})));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Connection));});expect(replaceState).toHaveBeenCalledTimes(1);expect(location.search).not.toContain('ads_connected');
 await act(async()=>{view.unmount();view=create(createElement(Connection));});expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(1);
});
it('checks running import status hourly without frequent polling or duplicate source writes',async()=>{
 vi.useFakeTimers();vi.stubGlobal('window',Object.assign(new EventTarget(),{location:{search:'',assign:vi.fn()}}));vi.stubGlobal('document',Object.assign(new EventTarget(),{hidden:false}));let running=true;const refreshed=vi.fn(),fetcher=vi.fn(async()=>Response.json(status({status:'connected',refresh_running:running})));vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Connection,{onRefreshed:refreshed}));});running=false;
 await act(async()=>{await vi.advanceTimersByTimeAsync(59*60000);});expect(refreshed).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(1);
 await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});expect(refreshed).toHaveBeenCalledTimes(1);const calls=fetcher.mock.calls.length;
 await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});expect(fetcher).toHaveBeenCalledTimes(calls);
});
it('recovers a transient failed callback once and starts fetching without replaying OAuth or losing browser identity',async()=>{
 vi.stubGlobal('window',{location:{search:'?view=budget&connection_error=ADS_TOKEN_EXCHANGE_FAILED',assign:vi.fn()}});
 const fetcher=vi.fn(async(_url:string,options?:any)=>{if(options?.method==='POST')return Response.json(JSON.parse(options.body).action==='recover'?{connected:true}:{complete:true,inventory_ads:10,accounts:1});return Response.json(status({pending_authorization:true}));});vi.stubGlobal('fetch',fetcher);
 await act(async()=>{view=create(createElement(Connection));});expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST').map(([,options])=>JSON.parse(options.body).action)).toEqual(['recover','refresh']);expect(text(view.toJSON())).toContain('Fetched 10 verified ad entries');
});
