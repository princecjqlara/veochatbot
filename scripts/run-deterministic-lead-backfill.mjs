// Supervises source collection and incremental, verified repairs without AI.
import fs from'node:fs';import path from'node:path';import{spawn}from'node:child_process';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {adRefreshCoversPages,currentAdRefreshReceipt} from './lib/connected-ad-inventory.mjs';
import { pendingHistoricalRepair, runningHistoricalSupervisor } from './lib/historical-backfill-state.mjs';
import { backfillCoverageComplete, databaseRetryDelay, retryableSourceError } from './lib/lead-source-coverage.mjs';
const dir=path.resolve('.vercel/historical-leads'),statusFile=path.join(dir,'background-status.json');
fs.mkdirSync(dir,{recursive:true});
const lockFile=path.join(dir,'supervisor.lock');
if(fs.existsSync(lockFile)){
 const previous=JSON.parse(fs.readFileSync(lockFile,'utf8'));
 if(runningHistoricalSupervisor(previous.pid,lockFile))throw Error('A backfill supervisor is already running');
 fs.unlinkSync(lockFile);
}
fs.writeFileSync(lockFile,JSON.stringify({pid:process.pid}),{flag:'wx'});
process.once('exit',()=>{try{if(JSON.parse(fs.readFileSync(lockFile,'utf8')).pid===process.pid)fs.unlinkSync(lockFile);}catch{}});
const status={pid:process.pid,started_at:new Date().toISOString(),status:'starting',ai_calls:0,ai_jobs_created:0,customer_messages_sent:0,scope:'connected_pages',refetch_new_contacts:true,refresh_requests_complete:false,calendar_backlog:{status:'waiting_for_database',complete:false},ad_refresh:{status:'waiting_for_database'},new_contact_discovery_status:'waiting_for_database',cycles:[],retained_live_histories:fs.existsSync(path.join(dir,'live/histories'))?fs.readdirSync(path.join(dir,'live/histories')).filter(file=>file.endsWith('.json.gz')).length:0};
const flush=()=>fs.writeFileSync(statusFile,JSON.stringify({...status,updated_at:new Date().toISOString()},null,2));
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const refreshRequest=read(path.join(dir,'connected-refetch-request.json')),refreshSince=refreshRequest?.requested_at||null;status.refresh_requested_at=refreshSince;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function command(script,args=[],label=script.replace(/\W/g,'-')){
 const jobId=randomUUID();if(script==='refetch-connected-ad-data.mjs')args=[...args,'--refresh-job-id='+jobId];
 const log=fs.openSync(path.join(dir,label+'.log'),'a');let done=false;
 const child=spawn(process.execPath,['scripts/'+script,...args,...(script==='collect-lead-reconciliation-sources.mjs'&&refreshSince?['--refresh-since='+refreshSince]:[])],{windowsHide:true,stdio:['ignore',log,log]});
 const result=new Promise(resolve=>{child.once('error',e=>{done=true;fs.closeSync(log);resolve({exit_code:1,error:e.message});});child.once('exit',code=>{if(done)return;done=true;fs.closeSync(log);resolve({exit_code:code});});});
 return{child,result,job_id:jobId,get done(){return done;}};
}
let lastRegistryRepair=0;
async function reconcileRegistry(force=false){
 const registry=path.resolve('.vercel/system-data-audit/latest-sources.jsonl'),auditDir=path.join(dir,'calendar-registry-audit');
 if(!fs.existsSync(registry)||!force&&Date.now()-lastRegistryRepair<1800000)return;
 if(pendingHistoricalRepair(auditDir)){
  status.status='resuming_calendar_registry_repair';flush();
  const resumed=await command('repair-historical-leads.mjs',['--apply','--audit-dir='+auditDir],'background-calendar-resume').result;
  if(resumed.exit_code||!read(path.join(auditDir,'repair-apply.json'))?.passed)throw Error('Calendar registry repair needs review; its pending manifest is retained');
 }
 status.status='verifying_calendar_registry';status.calendar_backlog={status:'verifying_saved_histories'};flush();
 const audit=await command('audit-historical-leads.mjs',['--registry='+registry,'--only-new'],'background-calendar-registry-audit').result;
 const report=read(path.join(auditDir,'audit.json'));if(audit.exit_code||!report?.passed)throw Error(report?.error||'Calendar registry audit failed; existing calendar records retained');
 if(report.matched>0){
  status.status='preflighting_calendar_registry';flush();
  const check=await command('repair-historical-leads.mjs',['--preflight','--audit-dir='+auditDir],'background-calendar-registry-preflight').result;
  if(check.exit_code||!read(path.join(auditDir,'repair-preflight.json'))?.passed)throw Error('Calendar registry preflight failed; source records retained');
  status.status='applying_calendar_registry';flush();
  const applied=await command('repair-historical-leads.mjs',['--apply','--audit-dir='+auditDir],'background-calendar-registry-apply').result,receipt=read(path.join(auditDir,'repair-apply.json'));
  if(applied.exit_code||!receipt?.passed)throw Error(receipt?.error||'Calendar registry apply interrupted; committed batches are saved');
  status.calendar_backlog={status:'saved_histories_reconciled',complete:!report.unmatched&&!report.unverified_pages?.length,matched_histories:report.matched,unimported_contacts:report.unmatched,already_reconciled:report.already_reconciled,unverified_pages:report.unverified_pages||[],...Object.fromEntries(['contact_dates_corrected','inquiry_sources_refined','stage_events_imported','projection_sources_refreshed'].map(key=>[key,receipt[key]||0]))};
 }else status.calendar_backlog={status:'no_unapplied_matching_histories',complete:!report.unmatched&&!report.unverified_pages?.length,unimported_contacts:report.unmatched,already_reconciled:report.already_reconciled,unverified_pages:report.unverified_pages||[]};
 lastRegistryRepair=Date.now();flush();
}
async function reconcile(final=false){
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
 status.cycles.push(cycle);await reconcileRegistry(final);status.status='collecting_sources';flush();
}
let listing,histories,ads;
try{
 const primary=read(path.join(dir,'repair-apply.json'));if(!primary?.passed||!primary.applied)throw Error('Finish the retained-history repair before starting the incremental scan');
 // No source collector or mutation starts until a bounded health probe succeeds.
 let failures=0;
 for(;;){
  let probe,ready=false,delay=30000;
  try{
   // A failed data API health check must not repeatedly open pooler connections.
   if(process.env.NEXT_PUBLIC_SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY){
    const response=await fetch(process.env.NEXT_PUBLIC_SUPABASE_URL+'/rest/v1/contacts?select=id&limit=0',{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY},signal:AbortSignal.timeout(10000)});
    if(!response.ok){const body=await response.json().catch(()=>({}));throw Object.assign(Error('Database data API is unavailable'),{code:body.code||'HTTP_'+response.status});}
   }
   probe=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:5000,query_timeout:5000});probe.on('error',()=>{});
   await probe.connect();await probe.query('SELECT 1');ready=true;
  }catch(error){
   delay=databaseRetryDelay(error,++failures);status.status='waiting_for_database';status.error='Database unavailable; completed repairs and pending manifests are retained';status.database_error_code=error.name==='TimeoutError'?'DATABASE_HEALTH_TIMEOUT':error.code||error.name;status.next_retry_at=new Date(Date.now()+delay).toISOString();flush();
  }finally{if(probe)await Promise.race([probe.end().catch(()=>{}),sleep(1000)]);}
  if(ready){delete status.error;delete status.next_retry_at;delete status.database_error_code;break;}await sleep(delay);
 }
 // Resume before starting collectors or replacing the live audit manifest.
 if(pendingHistoricalRepair(path.join(dir,'live-audit')))await reconcile();
 listing=command('collect-lead-reconciliation-sources.mjs',['--list','--discover-new-contacts','--refresh'],'background-list');
 histories=command('collect-lead-reconciliation-sources.mjs',['--histories'],'background-histories');
 ads=command('refetch-connected-ad-data.mjs',[],'background-ads');status.ad_refresh={status:'running'};
 status.status='collecting_sources';status.new_contact_discovery_status='running';status.environment_loaded=true;flush();
 let lastRepair=0,finalHistoryPass=false,sourceRetryRounds=0,adRetryRounds=0;
 for(;;){
  const files=fs.existsSync(path.join(dir,'live/histories'))?fs.readdirSync(path.join(dir,'live/histories')).filter(file=>file.endsWith('.json.gz')).length:0;
  status.retained_live_histories=files;flush();
  if(files&&Date.now()-lastRepair>180000){await reconcile();lastRepair=Date.now();}
  if(listing.done&&histories.done){
   const listed=await listing.result,loaded=await histories.result;
   if(listed.exit_code||loaded.exit_code)throw Error('Source connection interrupted; collection and repair checkpoints are retained');
   if(!finalHistoryPass){histories=command('collect-lead-reconciliation-sources.mjs',['--histories'],'background-histories');finalHistoryPass=true;continue;}
   if(ads&&!ads.done){status.ad_refresh={status:'running'};flush();await sleep(15000);continue;}
   await reconcile(true);const inventory=read(path.join(dir,'live/list-receipt.json')),sources=read(path.join(dir,'live/histories-receipt.json'));
   const adResult=await ads.result,rawAdReport=read(path.join(dir,'connected-ads-refresh.json')),adCurrent=currentAdRefreshReceipt(rawAdReport,ads.job_id,adResult.exit_code),adReport=adCurrent?rawAdReport:null,adFailures=(rawAdReport?.refresh_job_id===ads.job_id?rawAdReport.errors||[]:[]).filter(retryableSourceError);
   if(adFailures.length&&adRetryRounds<3){adRetryRounds++;status.ad_refresh={status:'retrying',attempt:adRetryRounds};flush();await sleep(adFailures.some(error=>[4,17,32,613,80004].includes(Number(error.code)))?600000:60000*adRetryRounds);ads=command('refetch-connected-ad-data.mjs',[],'background-ads');continue;}
   const retryable=[...(inventory?.pages||[]).flatMap(page=>page.error?[page.error]:[]),...(inventory?.unverified_pages||[]).map(page=>page.error),...(sources?.unverified_pages||[]).map(page=>page.error),...(sources?.errors||[])].filter(retryableSourceError);
   if(retryable.length&&sourceRetryRounds<3){
    sourceRetryRounds++;status.status='retrying_incomplete_sources';status.source_retry_round=sourceRetryRounds;status.retryable_source_errors=retryable.length;flush();
    // Quota failures get a longer pause to preserve capacity for live messaging.
    await sleep(retryable.some(error=>[4,17,32,613,80004].includes(Number(error.code)))?600000:60000*sourceRetryRounds);
    listing=command('collect-lead-reconciliation-sources.mjs',['--list','--discover-new-contacts'],'background-list');histories=command('collect-lead-reconciliation-sources.mjs',['--histories'],'background-histories');finalHistoryPass=false;continue;
   }
   status.source_scope_complete=backfillCoverageComplete(inventory,sources);status.new_contact_discovery_status=inventory?.coverage_complete?'completed_connected_inboxes':'incomplete';status.new_contacts_discovered=inventory?.new_contacts_discovered||0;
   const sameAdScope=adCurrent&&adRefreshCoversPages(adReport,(inventory?.pages||[]).map(page=>page.page_id));status.ad_refresh={complete:sameAdScope&&adReport?.complete===true,inventory_complete:adReport?.inventory_complete===true,daily_spend_complete:adReport?.daily_spend_complete===true,blocked:adReport?.ad_account_refresh_blocked||(!adCurrent?'Current ad refresh did not finish successfully':!sameAdScope?'Connected Page scope changed during refresh':null)};status.refresh_requests_complete=status.source_scope_complete&&status.ad_refresh.complete&&status.calendar_backlog.complete===true;
   if(status.source_scope_complete){
    status.status='verifying_live_calendar';flush();
    const started=Date.now(),verified=await command('verify-connected-calendar-refresh.mjs',[],'background-calendar-verification').result,receipt=read(path.join(dir,'calendar-refresh-verification.json'));
    status.calendar_report_validation={passed:verified.exit_code===0&&receipt?.passed===true&&Date.parse(receipt.started_at)>=started,cases:receipt?.cases?.length||0,error:receipt?.error||null};
    status.refresh_requests_complete=status.refresh_requests_complete&&status.calendar_report_validation.passed;
   }
   status.status=inventory?.expected_pages===0&&inventory?.scope_check_complete?'no_connected_pages':status.source_scope_complete?'completed_connected_sources':'completed_accessible_sources';
   status.unavailable_pages=(inventory?.pages||[]).filter(page=>!page.complete).map(page=>({page:page.page,error:page.error}));status.source_errors=sources?.errors||[];status.completed_at=new Date().toISOString();flush();break;
  }
  await sleep(15000);
 }
}catch(e){status.status='interrupted';status.error=e.message;flush();process.exitCode=1;for(const process of[listing,histories,ads])if(process&&!process.done)process.child.kill();}
