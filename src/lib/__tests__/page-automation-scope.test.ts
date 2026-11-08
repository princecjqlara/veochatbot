import {describe,it,expect,vi,afterEach} from 'vitest';import {getAutomationPageScope,scopeAutomationQuery} from '../page-automation-scope';
afterEach(()=>{vi.unstubAllEnvs();});
describe('separated Page automation ownership',()=>{
 it('preserves the database failure while refusing to release automation scope',async()=>{
  vi.stubEnv('VEO_WORKSPACE_ENABLED','true');
  const cause={code:'SUPABASE_UPSTREAM_522',message:'Supabase API temporarily unavailable (HTTP 522)'};
  await expect(getAutomationPageScope({rpc:vi.fn().mockResolvedValue({data:null,error:cause})})).rejects.toMatchObject({message:'Workspace page scope unavailable',cause});
 });
 it('preserves the original worker behavior while enforcement is disabled',async()=>{
  vi.stubEnv('VEO_ENFORCE_PAGE_RUNTIME_SCOPE','');const rpc=vi.fn(),query={in:vi.fn()};
  expect(await getAutomationPageScope({rpc})).toBeNull();expect(rpc).not.toHaveBeenCalled();expect(scopeAutomationQuery(query,null)).toBe(query);expect(query.in).not.toHaveBeenCalled();
 });
 it('filters before queue limits, handles an empty owned scope, and fails closed on unavailable ownership',async()=>{
  vi.stubEnv('VEO_ENFORCE_PAGE_RUNTIME_SCOPE','true');const id='00000000-0000-4000-8000-000000000001',rpc=vi.fn().mockResolvedValue({data:[id],error:null}),query={in:vi.fn().mockReturnThis()};
  const scope=await getAutomationPageScope({rpc});scopeAutomationQuery(query,scope,'campaigns.page_id');expect(query.in).toHaveBeenCalledWith('campaigns.page_id',[id]);
  scopeAutomationQuery(query,[]);expect(query.in).toHaveBeenLastCalledWith('page_id',['00000000-0000-0000-0000-000000000000']);
  rpc.mockResolvedValue({data:null,error:{message:'timeout'}});await expect(getAutomationPageScope({rpc})).rejects.toThrow('temporarily unavailable');
  rpc.mockResolvedValue({data:null,error:null});await expect(getAutomationPageScope({rpc})).rejects.toThrow('not configured');
 });
});
