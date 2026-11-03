import fs from 'node:fs';import path from 'node:path';import {parseEnv} from 'node:util';
import {assertProjectCredentials,VEO_TARGET_PROJECT} from './lib/database-migration-safety.mjs';
const apply=process.argv.includes('--apply'),target=parseEnv(fs.readFileSync('.env.local','utf8'));assertProjectCredentials(target,VEO_TARGET_PROJECT);
const project=JSON.parse(fs.readFileSync('.vercel/project.json','utf8')),auth=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'com.vercel.cli/Data/auth.json'),'utf8'));
const headers={Authorization:'Bearer '+auth.token,'Content-Type':'application/json'},base='https://api.vercel.com/v9/projects/'+project.projectId+'/env',query='?teamId='+project.orgId;
async function call(url,options={}){const r=await fetch(url,{...options,headers,signal:AbortSignal.timeout(25000)}),b=await r.json();if(!r.ok){let message=b.error?.message||'';for(const v of Object.values(target).filter(v=>v.length>6))message=message.split(v).join('[redacted]');throw Error('Vercel environment request failed: '+r.status+' '+(b.error?.code||'')+' '+message);}return b;}
const original=await call(base+query+'&decrypt=true');const production=original.envs.filter(e=>e.target?.includes('production'));
const backup='.vercel/veo-reset/vercel-production-before.json';if(!fs.existsSync(backup))fs.writeFileSync(backup,JSON.stringify(original,null,2));
const dbKey=k=>/^(NEXT_PUBLIC_SUPABASE_|SUPABASE_|DATABASE_|POSTGRES_)/.test(k);
const desired={...Object.fromEntries(Object.entries(target).filter(([k])=>dbKey(k))),CONTACT_PROFILE_PROCESSING_MODE:'local',VEO_PAGE_SCOPE_ENFORCED:'true',VEO_ENFORCE_PAGE_RUNTIME_SCOPE:'true'};
async function decryptDesired(entries){for(const entry of entries.filter(e=>e.key in desired&&e.type!=='sensitive')){const clear=await call(base.replace('/v9/','/v1/')+'/'+entry.id+query);if(typeof clear.value!=='string')throw Error('Vercel could not decrypt a configuration variable: '+entry.key);entry.value=clear.value;}}
await decryptDesired(original.envs);
const changed=[],removed=[];
for(const [key,value]of Object.entries(desired)){
 const entries=original.envs.filter(e=>e.key===key);
 const missing=['production','preview','development'].filter(t=>!entries.some(e=>!e.gitBranch&&e.target?.includes(t)));
 if(entries.every(e=>e.value===value)&&!missing.length)continue;
 if(apply){
  for(const entry of entries)if(entry.value!==value)await call(base+'/'+entry.id+query,{method:'PATCH',body:JSON.stringify({value,type:entry.visibility==='secret'?'sensitive':entry.type})});
  if(missing.length)for(const t of missing)await call(base+query,{method:'POST',body:JSON.stringify({key,value,type:t==='development'?'plain':'encrypted',target:[t]})});
 }changed.push(key);
}
for(const entry of original.envs.filter(e=>dbKey(e.key)&&!(e.key in desired))){if(apply)await call(base+'/'+entry.id+query,{method:'DELETE'});removed.push(entry.key);}
const after=apply?(await call(base+query+'&decrypt=true')).envs.filter(e=>e.target?.includes('production')):production;
if(apply)await decryptDesired(after);
if(apply){const env=Object.fromEntries(after.map(e=>[e.key,e.value]));for(const [key,value]of Object.entries(desired)){const actual=after.find(e=>e.key===key);if(!actual)throw Error('Target setting is absent: '+key);if(actual.type==='sensitive')env[key]=value;else if(actual.value!==value)throw Error('Target setting differs: '+key);}assertProjectCredentials(env,VEO_TARGET_PROJECT);for(const entry of production.filter(e=>!dbKey(e.key)&&!(e.key in desired))){if(!after.some(e=>e.key===entry.key&&e.value===entry.value))throw Error('An unrelated production setting changed: '+entry.key);}}
const report={applied:apply,target_project:VEO_TARGET_PROJECT,changed_keys:changed,removed_keys:removed,openrouter_preserved:after.find(e=>e.key==='OPENROUTER_API_KEY')?.value===production.find(e=>e.key==='OPENROUTER_API_KEY')?.value,production_deployment_required:true};
fs.writeFileSync('.vercel/veo-reset/environment-cutover.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
