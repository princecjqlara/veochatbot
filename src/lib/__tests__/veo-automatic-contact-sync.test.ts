import { afterEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('../veo-contact-identity-sync',()=>({readContactIdentityBatch:m.read}));
import {syncAutomaticContactIdentities} from '../veo-automatic-contact-sync';
afterEach(()=>{vi.resetAllMocks();});
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
