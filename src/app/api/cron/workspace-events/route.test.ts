import {afterEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import fs from 'node:fs';
const m=vi.hoisted(()=>({rpc:vi.fn(),events:vi.fn(),identity:vi.fn(),job:vi.fn((_name:any,fn:any)=>fn())}));
vi.mock('@/lib/supabase',()=>({getSupabaseAdmin:()=>({rpc:m.rpc})}));
vi.mock('@/lib/veo-events',()=>({processWorkspaceEvents:m.events}));
vi.mock('@/lib/veo-automatic-contact-sync',()=>({syncAutomaticContactIdentities:m.identity}));
vi.mock('@/lib/background-run',()=>({runBackgroundJob:m.job}));
vi.mock('@/app/api/facebook/webhook/route',()=>({POST:vi.fn()}));
import {GET} from './route';
import {GET as identities} from '../contact-identities/route';
afterEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs();});
const request=(auth=true)=>new NextRequest('https://veo.test/api/cron/workspace-events',{headers:auth?{Authorization:'Bearer cron'}:{}});
it('requires authentication before either collector touches the database',async()=>{
 vi.stubEnv('CRON_SECRET','cron');expect((await GET(request(false))).status).toBe(401);expect((await identities(request(false))).status).toBe(401);expect(m.rpc).not.toHaveBeenCalled();expect(m.identity).not.toHaveBeenCalled();
});
it('processes live events independently of salary and planning and starts by recovering client identities',async()=>{
 vi.stubEnv('CRON_SECRET','cron');vi.stubEnv('VEO_WORKSPACE_ENABLED','true');m.rpc.mockResolvedValue({data:12});m.events.mockResolvedValue(200);
 const r=await GET(request());expect(await r.json()).toEqual({ok:true,contacts_recovered:12,processed:200});
 expect(m.rpc).toHaveBeenCalledWith('veo_recover_queued_contact_identities',{p_limit:1000});expect(m.events).toHaveBeenCalledWith(expect.any(Function),'https://veo.test',140000,{maxEvents:1000});
 expect(m.rpc.mock.invocationCallOrder[0]).toBeLessThan(m.events.mock.invocationCallOrder[0]);
});
it('schedules both independent collectors every minute',()=>{
 const config=JSON.parse(fs.readFileSync('vercel.json','utf8'));
 for(const path of ['/api/cron/workspace-events','/api/cron/contact-identities'])expect(config.crons).toContainEqual({path,schedule:'* * * * *'});
});
