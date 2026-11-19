import { afterEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn(),capacity:vi.fn(async()=>{})}));
vi.mock('../veo-contact-identity-sync',()=>({readContactIdentityBatch:m.read}));
vi.mock('../veo-storage-health',()=>({requireStorageForOptionalWork:m.capacity}));
import {syncAutomaticContactIdentities} from '../veo-automatic-contact-sync';
afterEach(()=>{vi.resetAllMocks();vi.restoreAllMocks();});
const page={page_id:'page',owner_id:'owner',fb_page_id:'111',access_token:'private',cursor:'older',lease_owner:'lease'};
it('checks recent identities as well as historical progress and saves at most fifty at a time',async()=>{
 m.read.mockImplementation(async(_page:any,cursor?:string)=>({contacts:cursor?Array.from({length:50},(_,n)=>({psid:String(n+30),name:'Name'})):Array.from({length:50},(_,n)=>({psid:String(n),name:'Name'})),next_cursor:cursor?'next-old':'head-next'}));
 const rpc=vi.fn(async(name:string,args?:any)=>({data:name==='veo_claim_contact_identity_pages'?[page]:name==='veo_seed_contact_identities'?{inserted:args.p_contacts.length,updated_names:1}:true}));
 expect(await syncAutomaticContactIdentities({rpc})).toEqual({pages:1,inserted:80,updated_names:2,failed:0});
 expect(m.read.mock.calls.map(c=>c[1])).toEqual([undefined,'older']);
 const saves=rpc.mock.calls.filter(c=>c[0]==='veo_seed_contact_identities');expect(saves.every(c=>c[1].p_contacts.length<=50)).toBe(true);
 expect(rpc).toHaveBeenCalledWith('veo_finish_contact_identity_page',expect.objectContaining({p_page:'page',p_lease:'lease',p_cursor:'next-old',p_error:null}));
});
it('retains a failed Page for retry while another Page completes',async()=>{
 m.read.mockImplementation(async(p:any)=>{if(p.page_id==='page')throw Error('Provider unavailable');return{contacts:[{psid:'123',name:'Client'}],next_cursor:null};});
 const rpc=vi.fn(async(name:string)=>({data:name==='veo_claim_contact_identity_pages'?[page,{...page,page_id:'other',cursor:null}]:name==='veo_seed_contact_identities'?{inserted:1}:true}));
 expect(await syncAutomaticContactIdentities({rpc})).toEqual({pages:2,inserted:1,updated_names:0,failed:1});
 expect(rpc).toHaveBeenCalledWith('veo_finish_contact_identity_page',expect.objectContaining({p_page:'page',p_error:expect.stringContaining('retry')}));
});
it('finishes one Page checkpoint before reading the next Page',async()=>{
 m.read.mockImplementation(async()=>({contacts:[{psid:'123',name:'Client'}],next_cursor:null}));
 const rpc=vi.fn(async(name:string)=>({data:name==='veo_claim_contact_identity_pages'?[page,{...page,page_id:'other',cursor:null}]:name==='veo_seed_contact_identities'?{inserted:1}:true}));
 expect(await syncAutomaticContactIdentities({rpc})).toMatchObject({pages:2,failed:0});
 const finish=rpc.mock.calls.findIndex(([name,args]:any)=>name==='veo_finish_contact_identity_page'&&args.p_page==='page');
 const nextRead=m.read.mock.calls.findIndex(([p]:any)=>p.page_id==='other');
 expect(rpc.mock.invocationCallOrder[finish]).toBeLessThan(m.read.mock.invocationCallOrder[nextRead]);
 expect(rpc).toHaveBeenCalledWith('veo_claim_contact_identity_pages',{p_limit:2});
});
it('stops before another write batch on pressure and does not advance an incompletely saved cursor',async()=>{
 m.read.mockImplementation(async(_page:any,cursor?:string)=>({contacts:Array.from({length:50},(_,n)=>({psid:String(n+(cursor?50:0)),name:'Client'})),next_cursor:cursor?'next-old':'head-next'}));
 m.capacity.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(Error('Database pressure'),{code:'STORAGE_ATTENTION'}));
 const rpc=vi.fn(async(name:string,args?:any)=>({data:name==='veo_claim_contact_identity_pages'?[page]:name==='veo_seed_contact_identities'?{inserted:args.p_contacts.length}:true}));
 expect(await syncAutomaticContactIdentities({rpc})).toMatchObject({pages:1,inserted:50,failed:1});
 expect(rpc.mock.calls.filter(([name])=>name==='veo_seed_contact_identities')).toHaveLength(1);
 expect(rpc).toHaveBeenCalledWith('veo_finish_contact_identity_page',expect.objectContaining({p_page:'page',p_cursor:null,p_error:expect.stringContaining('paused')}));
});
it('releases unstarted Pages for retry when the first Page consumes the remaining work budget',async()=>{
 let now=0;vi.spyOn(Date,'now').mockImplementation(()=>now);
 m.read.mockImplementation(async()=>{now=15000;return{contacts:[{psid:'123',name:'Client'}],next_cursor:null};});
 const rpc=vi.fn(async(name:string)=>{if(name==='veo_finish_contact_identity_page')now=25000;return{data:name==='veo_claim_contact_identity_pages'?[{...page,cursor:null},{...page,page_id:'other',cursor:null}]:name==='veo_seed_contact_identities'?{inserted:1}:true};});
 expect(await syncAutomaticContactIdentities({rpc})).toMatchObject({pages:2,inserted:1,failed:1});
 expect(m.read).toHaveBeenCalledTimes(1);
 expect(rpc).toHaveBeenCalledWith('veo_finish_contact_identity_page',expect.objectContaining({p_page:'other',p_cursor:null,p_error:expect.stringContaining('retry')}));
});
