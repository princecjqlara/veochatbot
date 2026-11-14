import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({rpc:vi.fn(),policies:vi.fn()}));
vi.mock('@/lib/supabase',()=>({getSupabaseAdmin:()=>{const chain:any={select:()=>chain,eq:()=>chain,limit:m.policies};return{from:()=>chain,rpc:m.rpc};}}));
import {GET} from './route';
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('CRON_SECRET','secret');vi.stubEnv('VEO_WORKSPACE_ENABLED','true');m.policies.mockResolvedValue({data:[{tenant_id:'tenant'}]});m.rpc.mockResolvedValue({data:{new_announcements:1,offered:1}});});
afterEach(()=>{vi.unstubAllEnvs();});
const req=(auth=true)=>new Request('https://veo.test/api/cron/editor-dispatch',{headers:auth?{Authorization:'Bearer secret'}:{}});
it('requires scheduler authentication and workspace enablement',async()=>{
 expect((await GET(req(false))).status).toBe(401);expect(m.policies).not.toHaveBeenCalled();
 vi.stubEnv('VEO_WORKSPACE_ENABLED','false');expect(await(await GET(req())).json()).toEqual({skipped:true});expect(m.rpc).not.toHaveBeenCalled();
});
it('runs editor dispatch independently and reports failures rather than false success',async()=>{
 expect(await(await GET(req())).json()).toMatchObject({ok:true,announced:1,offered:1,failed:0});
 expect(m.rpc).toHaveBeenCalledWith('veo_automatic_intake_tick',{p_tenant:'tenant'});
 m.rpc.mockResolvedValue({error:{code:'57014'}});expect((await GET(req())).status).toBe(503);
});
