import fs from 'node:fs';import path from 'node:path';import {parseEnv} from 'node:util';import {assertProjectCredentials,VEO_TARGET_PROJECT} from './lib/database-migration-safety.mjs';
const target=parseEnv(fs.readFileSync('.vercel/veobot-intended-project.env.local','utf8'));assertProjectCredentials(target,VEO_TARGET_PROJECT);
const root=path.resolve('.vercel/veo-reset');fs.mkdirSync(root,{recursive:true});
for(const file of ['.env.local','../.env']){
 if(!fs.existsSync(file))continue;const old=fs.readFileSync(file,'utf8'),env=parseEnv(old),snapshot=path.join(root,path.basename(path.dirname(path.resolve(file)))+'-'+path.basename(file)+'.before-reset');if(!fs.existsSync(snapshot))fs.writeFileSync(snapshot,old);
 const preserved=Object.fromEntries(Object.entries(env).filter(([k])=>!/^(NEXT_PUBLIC_SUPABASE_|SUPABASE_|DATABASE_|POSTGRES_)/.test(k)));
 const database=Object.fromEntries(Object.entries(target).filter(([k])=>/^(NEXT_PUBLIC_SUPABASE_|SUPABASE_|DATABASE_|POSTGRES_)/.test(k)));
 const next={...preserved,...database,CONTACT_PROFILE_PROCESSING_MODE:'local',VEO_PAGE_SCOPE_ENFORCED:'true',VEO_ENFORCE_PAGE_RUNTIME_SCOPE:'true'};assertProjectCredentials(next,VEO_TARGET_PROJECT);
 fs.writeFileSync(file,Object.entries(next).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n');
 console.log(JSON.stringify({file,target_project:VEO_TARGET_PROJECT,openrouter_unchanged:env.OPENROUTER_API_KEY===next.OPENROUTER_API_KEY&&env.OPENROUTER_MODEL===next.OPENROUTER_MODEL}));
}
