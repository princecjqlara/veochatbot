// Supervises source collection and incremental, verified repairs without AI.
import fs from'node:fs';import path from'node:path';import{spawn}from'node:child_process';
import pg from 'pg';
import { pendingHistoricalRepair } from './lib/historical-backfill-state.mjs';
const dir=path.resolve('.vercel/historical-leads'),statusFile=path.join(dir,'background-status.json');
fs.mkdirSync(dir,{recursive:true});
const lockFile=path.join(dir,'supervisor.lock');
if(fs.existsSync(lockFile)){
 const previous=JSON.parse(fs.readFileSync(lockFile,'utf8'));
 try{process.kill(previous.pid,0);throw Error('A backfill supervisor is already running');}catch(error){if(error.code!=='ESRCH')throw error;}
 fs.unlinkSync(lockFile);
}
fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid}),{flag:'wx'});
process.once('exit',()=>{try{if(JSON.parse(fs.readFileSync(lockFile,'utf8')).pid===process.pid)fs.unlinkSync(lockFile);}catch{}});
const status={pid:process.pid,started_at:new Date().toISOString(),status:'starting',ai_calls:0,ai_jobs_created:0,customer_messages_sent:0,cycles:[]};
const flush=()=>fs.writeFileSync(statusFile,JSON.stringify({...status,updated_at:new Date().toISOString()},null,2));
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function command(script,args=[],label=script.replace(/\W/g,'-')){
 const log=fs.openSync(path.join(dir,label+'.log'),'a');let done=false;
 const child=spawn(process.execPath,['scripts/'+script,...args],{windowsHide:true,stdio:['ignore',log,log]});
 const result=new Promise(resolve=>{child.once('error',e=>{done=true;fs.closeSync(log);resolve({exit_code:1,error:e.message});});child.once('exit',code=>{if(done)return;done=true;fs.closeSync(log);resolve({exit_code:code});});});
 return{child,result,get done(){return done;}};
}
async function reconcile(){
 const auditDir=path.join(dir,'live-audit');
 if(pendingHistoricalRepair(auditDir)){
  status.status='resuming_saved_repair';flush();
  const resumed=await command('repair-historical-leads.mjs',['--apply','--audit-dir='+auditDir],'background-resume').result;
  if(resumed.exit_code||!read(path.join(auditDir,'repair-apply.json'))?.passed)throw Error('Saved repair could not resume; its manifest is retained for review');
 }
 status.status='verifying_sources';flush();
 const audit=await command('audit-historical-leads.mjs',['--live','--only-new'],'background-audit').result;
 const report=read(path.join(dir,'live-audit/audit.json'));if(audit.exit_code||!report?.passed)throw Error(report?.error||'Source audit failed; no partial repairs published');
 const cycle={at:new Date().toISOString(),sources:report.files,already_reconciled:report.already_reconciled,messages:report.messages};
 if(report.matched>0){
  status.status='repair_dry_run';flush();const check=await command('repair-historical-leads.mjs',['--preflight','--audit-dir='+path.join(dir,'live-audit')],'background-preflight').result;
  if(check.exit_code||!read(path.join(dir,'live-audit/repair-preflight.json'))?.passed)throw Error('Repair preflight failed; previous data retained');
  status.status='applying_verified_sources';flush();const apply=await command('repair-historical-leads.mjs',['--apply','--audit-dir='+path.join(dir,'live-audit')],'background-apply').result,receipt=read(path.join(dir,'live-audit/repair-apply.json'));
  if(apply.exit_code||!receipt?.passed)throw Error(receipt?.error||'Repair interrupted; committed batches are checkpointed');
  for(const key of ['contact_dates_corrected','inquiry_sources_refined','stage_events_imported','pipeline_stages_corrected','projection_sources_refreshed'])cycle[key]=receipt[key];
 }
 status.cycles.push(cycle);status.status='collecting_sources';flush();
}
let listing,histories;
try{
 const primary=read(path.join(dir,'repair-apply.json'));if(!primary?.passed||!primary.applied)throw Error('Finish the retained-history repair before starting the incremental scan');
 // No source collector or mutation starts until a bounded health probe succeeds.
 for(;;){
  const probe=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:5000,query_timeout:5000});probe.on('error',()=>{});
  let ready=false;try{await probe.connect();await probe.query('SELECT 1');ready=true;}catch{status.status='waiting_for_database';status.error='Database unavailable; completed repairs and pending manifests are retained';flush();}finally{await Promise.race([probe.end().catch(()=>{}),sleep(1000)]);}
  if(ready){delete status.error;break;}await sleep(30000);
 }
 // Resume before starting collectors or replacing the live audit manifest.
 if(pendingHistoricalRepair(path.join(dir,'live-audit')))await reconcile();
 listing=command('collect-lead-reconciliation-sources.mjs',['--list'],'background-list');
 histories=command('collect-lead-reconciliation-sources.mjs',['--histories'],'background-histories');
 status.status='collecting_sources';status.environment_loaded=true;flush();
 let lastRepair=0,finalHistoryPass=false;
 for(;;){
  const files=fs.existsSync(path.join(dir,'live/histories'))?fs.readdirSync(path.join(dir,'live/histories')).filter(file=>file.endsWith('.json.gz')).length:0;
  status.retained_live_histories=files;flush();
  if(files&&Date.now()-lastRepair>180000){await reconcile();lastRepair=Date.now();}
  if(listing.done&&histories.done){
   const listed=await listing.result,loaded=await histories.result;
   if(listed.exit_code||loaded.exit_code)throw Error('Source connection interrupted; collection and repair checkpoints are retained');
   if(!finalHistoryPass){histories=command('collect-lead-reconciliation-sources.mjs',['--histories'],'background-histories');finalHistoryPass=true;continue;}
   await reconcile();const inventory=read(path.join(dir,'live/list-receipt.json')),sources=read(path.join(dir,'live/histories-receipt.json'));
   status.status=inventory?.coverage_complete&&sources?.coverage_complete?'completed':'completed_accessible_sources';
   status.unavailable_pages=(inventory?.pages||[]).filter(page=>!page.complete).map(page=>({page:page.page,error:page.error}));status.source_errors=sources?.errors||[];status.completed_at=new Date().toISOString();flush();break;
  }
  await sleep(15000);
 }
}catch(e){status.status='interrupted';status.error=e.message;flush();process.exitCode=1;for(const process of[listing,histories])if(process&&!process.done)process.child.kill();}
