// Explicit operator maintenance only. Never called by migrations, build,
// deployment or the scheduler. The reviewed plan pins the current staff IDs.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import pg from 'pg';
import {assertProjectCredentials,VEO_RECOVERY_PROJECT} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
import {inspectWorkforceReset,applyWorkforceReset} from './lib/workforce-reset.mjs';
import {inspectLegacyAuthors,applyLegacyAuthorReset} from './lib/workforce-legacy-authors.mjs';
const modes=['--plan','--preflight','--apply'].filter(v=>process.argv.includes(v));assert.equal(modes.length,1,'Choose one of --plan, --preflight or --apply');const mode=modes[0].slice(2);
const legacy=process.argv.includes('--legacy-authors'),prefix=legacy?'legacy-':'';
const project=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];assert.equal(project,VEO_RECOVERY_PROJECT,'Reset targets only the approved recovery workspace');
const owner=fs.readFileSync('src/config/veo-owner.ts','utf8').match(/CJ_OWNER_USER_ID\s*=\s*'([^']+)'/)[1];
const db=new pg.Client({...await migrationConnectionOptions(assertProjectCredentials(process.env,project).connectionString),connectionTimeoutMillis:30000,query_timeout:60000});db.on('error',()=>{});
const directory=path.resolve('.vercel/workforce-fresh-start');assert(directory.startsWith(path.resolve('.vercel')+path.sep));fs.mkdirSync(directory,{recursive:true});
const report={at:new Date().toISOString(),mode,project,messagesSent:0,customerRecordsChanged:0};
try{
 await db.connect();await db.query(mode==='plan'?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN ISOLATION LEVEL REPEATABLE READ');
 await db.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='45s';SET LOCAL jit=off;SET LOCAL plan_cache_mode=force_custom_plan");
 const tenant=(await db.query('SELECT id FROM public.veo_tenants WHERE owner_id=$1',[owner])).rows[0]?.id;assert(tenant,'Expected Owner workspace');
 if(mode!=='plan'){
  assert((await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('veo-workforce-reset:'||$1,0)) locked",[tenant])).rows[0].locked,'Workforce reset already running');
  await db.query('LOCK TABLE public.veo_accounts,public.veo_teams IN SHARE ROW EXCLUSIVE MODE');
 }
 const context=await(legacy?inspectLegacyAuthors:inspectWorkforceReset)(db,{owner,tenant});report.plan=context.plan;
 assert.equal(context.plan.blockers.length,0,'Protected business references require a narrower cleanup');
 if(mode==='plan'){assert(context.plan.staff.length,'There are no matching non-Owner identities');fs.writeFileSync(path.join(directory,prefix+'plan.json'),JSON.stringify(context.plan,null,2));await db.query('ROLLBACK');}
 else{
  const pinned=JSON.parse(fs.readFileSync(path.join(directory,prefix+'plan.json'),'utf8'));assert.equal(pinned.fingerprint,context.plan.fingerprint,'Identity roster changed; generate and review a new plan');
  const result=await(legacy?applyLegacyAuthorReset:applyWorkforceReset)(db,context,{backup:async backup=>{
   const file=path.join(directory,prefix+mode+'-backup.private.json');fs.writeFileSync(file,JSON.stringify(backup,null,2),{flag:'wx'});
  }});Object.assign(report,result);await db.query(mode==='apply'?'COMMIT':'ROLLBACK');report.applied=mode==='apply';
 }
 report.passed=true;
}catch(error){await db.query('ROLLBACK').catch(()=>{});report.passed=false;report.error=error.message;process.exitCode=1;}
finally{await db.end();fs.writeFileSync(path.join(directory,prefix+mode+'-receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
