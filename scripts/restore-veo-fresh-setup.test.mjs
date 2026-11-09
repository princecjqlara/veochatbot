import {expect,it} from 'vitest';
import {validateRecoveryRoster,canonicalValue,freshSetupTables} from './lib/veo-fresh-setup.mjs';
const roster=()=>({tenant_id:'tenant',pages:[{id:'page'}],accounts:[
 {user_id:'member',name:'Member',role:'member',parent_id:'owner',page_ids:['page']},
 {user_id:'owner',name:'Owner',role:'owner',parent_id:null,page_ids:['page']} ]});
it('orders verified identities without inventing missing grants, parents or roles',()=>{
 expect(validateRecoveryRoster(roster(),'owner').map(a=>a.user_id)).toEqual(['owner','member']);
 const missing=roster();missing.accounts[0].parent_id='missing';expect(()=>validateRecoveryRoster(missing,'owner')).toThrow('supervisor');
 const cycle=roster();cycle.accounts[0].parent_id='member';expect(()=>validateRecoveryRoster(cycle,'owner')).toThrow('cycle');
 const grant=roster();grant.accounts[0].page_ids=['another'];expect(()=>validateRecoveryRoster(grant,'owner')).toThrow('grant');
 expect(()=>validateRecoveryRoster(roster(),'different-owner')).toThrow('owner');
});
it('compares nested knowledge/configuration values while excluding historical tables from restore',()=>{
 expect(JSON.stringify(canonicalValue({options:{b:2,a:1}}))).toBe(JSON.stringify(canonicalValue({options:{a:1,b:2}})));
 expect(JSON.stringify(canonicalValue({options:{a:1}}))).not.toBe(JSON.stringify(canonicalValue({options:{a:2}})));
 for(const name of ['contacts','contact_tags','contact_profile_snapshots','veo_payments','veo_orders','chatbot_contact_states','chatbot_follow_up_jobs'])expect(freshSetupTables).not.toContain(name);
 expect(freshSetupTables).toContain('chatbot_knowledge_documents');expect(freshSetupTables).toContain('tags');
});
