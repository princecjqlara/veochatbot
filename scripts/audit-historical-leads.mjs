// Offline, deterministic source reconciliation. Never calls an AI or sends messages.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {gunzipSync}from'node:zlib';
import {createRequire}from'node:module';import{build}from'esbuild';import pg from'pg';
import{administrative,paymentSignal}from'../src/lib/conversion-runtime/evidence.js';
import {connectedPageScope} from './lib/connected-pages.mjs';
import {calendarRegistryEntries} from './lib/calendar-source-registry.mjs';
import {pendingHistoricalRepair} from './lib/historical-backfill-state.mjs';
const registryArg=process.argv.find(arg=>arg.startsWith('--registry='))?.slice(11),registryMode=Boolean(registryArg);
const live=process.argv.includes('--live')||registryMode,root=path.resolve('..'),dir=path.resolve('.vercel/historical-leads'+(registryMode?'/calendar-registry-audit':live?'/live-audit':''));fs.mkdirSync(dir,{recursive:true});
if(pendingHistoricalRepair(dir))throw Error('Resume the saved repair before replacing its audit manifest');
await build({stdin:{contents:"export {parseMessengerStageEvent} from './src/lib/messenger-stage-sync.ts'; export {projectionCacheFromMessages} from './src/lib/contact-projection-refresh.ts';",resolveDir:process.cwd(),loader:'ts'},outfile:path.join(dir,'parser.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const{parseMessengerStageEvent,projectionCacheFromMessages}=createRequire(import.meta.url)(path.join(dir,'parser.cjs'));
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},query_timeout:120000,connectionTimeoutMillis:15000});db.on('error',()=>{});
const report={started_at:new Date().toISOString(),read_only:true,ai_calls:0,messages_sent:0,files:0,messages:0,complete:0,partial:0,matched:0,unmatched:0,with_stages:0,stage_events:0,missing_stage_events:0,first_date_differences:0,source_date_differences:0,missing_sources:0,new_page_acknowledgements:0,existing_payment_validation:{},pages:{},errors:[]};
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
const safePath=p=>{const full=path.resolve(root,p);if(!full.startsWith(root+path.sep))throw Error('Archive escaped workspace');return full;};
const sourceText=p=>{const data=fs.readFileSync(p);return(p.endsWith('.gz')?gunzipSync(data).toString('utf8'):data.toString('utf8')).replace(/^\uFEFF/,'');};
const read=p=>JSON.parse(sourceText(p));
const temporaryManifest=path.join(dir,'manifest.jsonl.tmp'),output=fs.openSync(temporaryManifest,'w'),seen=new Set();
const appliedSources=new Set();report.already_reconciled=0;
try{
 const registryFile=registryMode?path.resolve(registryArg):null;if(registryFile&&!registryFile.startsWith(path.resolve('.vercel')+path.sep))throw Error('Registry must remain inside the ignored audit directory');
 const archiveDir=path.join(root,'data/industry-conversion-2026-10-24'),metadata=live?null:read(path.join(root,'data/conversion-forecast-prototype/metadata.json')),liveDir=path.resolve('.vercel/historical-leads/live/histories'),archiveContacts=registryMode?fs.readFileSync(registryFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):live?fs.readdirSync(liveDir).filter(file=>/^[0-9a-f-]{36}_\d+\.json\.gz$/.test(file)).map(file=>({page_id:file.slice(0,36),psid:file.slice(37,-8),file:path.relative(root,path.join(liveDir,file))})):read(path.join(archiveDir,'contacts.json'));
 await db.connect();const pages=(await db.query(registryMode?'SELECT p.id,p.name,p.fb_page_id,p.access_token FROM pages p WHERE EXISTS(SELECT 1 FROM user_pages u WHERE u.page_id=p.id)':'SELECT id,name,fb_page_id FROM pages')).rows;
 let registryEntries=[];
 if(registryMode){const scope=await connectedPageScope(pages,async page=>{const response=await fetch('https://graph.facebook.com/v24.0/'+page.fb_page_id+'/conversations?fields=id&limit=1',{headers:{Authorization:'Bearer '+page.access_token},signal:AbortSignal.timeout(8000)}),body=await response.json();if(!response.ok||body.error)throw Object.assign(Error('Page access unavailable'),{code:body.error?.code||response.status});return body;});report.scope='connected_pages';report.unverified_pages=scope.unverified;report.disconnected_pages_excluded=scope.excluded;report.connected_page_ids=scope.connected.map(page=>page.id);registryEntries=calendarRegistryEntries(archiveContacts,pages,report.connected_page_ids).map(entry=>({...entry,file:safePath(entry.file)}));}
 if(live&&process.argv.includes('--only-new')){const exists=(await db.query("SELECT to_regclass('app_private.lead_reconciliation_changes') IS NOT NULL AS ok")).rows[0].ok;if(exists)for(const row of(await db.query("SELECT DISTINCT r.page_id,c.psid,r.evidence->>'archive_sha256' AS hash FROM app_private.lead_reconciliation_changes r JOIN contacts c ON c.id=r.contact_id AND c.page_id=r.page_id"+(registryMode?'':" WHERE r.evidence->>'archive_path' LIKE '%/live/histories/%'"))).rows)appliedSources.add(row.page_id+':'+row.psid+':'+row.hash);}
 const fbIds=new Set(archiveContacts.map(c=>c.fb_page_id)),livePageIds=new Set(archiveContacts.map(c=>c.page_id)),pageIds=pages.filter(p=>live?livePageIds.has(p.id):fbIds.has(p.fb_page_id)||p.name==='Onset Media Agency').map(p=>p.id);
 const scopedPageIds=registryMode?report.connected_page_ids:pageIds;
 const contacts=(await db.query('SELECT c.id,c.page_id,c.psid,c.first_interaction_at,c.pipeline_stage,c.pipeline_stage_source,c.messenger_stage_event_at,c.messenger_stage_message_id,s.first_inquiry_at,s.first_message_id,s.inquiry_basis,f.payment_at,f.payment_evidence_id,f.source_cutoff_at'+(live?',to_jsonb(f) AS previous_cache':'')+' FROM contacts c LEFT JOIN ad_contact_sources s ON s.contact_id=c.id LEFT JOIN contact_conversion_cache f ON f.contact_id=c.id WHERE c.page_id=ANY($1::uuid[])',[scopedPageIds])).rows;
 console.log(JSON.stringify({phase:'sources_loaded',contacts:contacts.length,pages:pageIds.length}));
 const byIdentity=new Map(contacts.map(c=>[c.page_id+':'+c.psid,c]));
 const stored=new Set((await db.query('SELECT page_id,message_id FROM messenger_lead_stage_events')).rows.map(e=>e.page_id+':'+e.message_id));
 await db.end();
 const entries=registryMode?registryEntries:archiveContacts.map(c=>({page:pages.find(p=>live?p.id===c.page_id:p.fb_page_id===c.fb_page_id),psid:c.psid,file:safePath(live?c.file:c.history_path),cutoff:metadata?.source_cutoff_utc}));
 const onset=pages.find(p=>p.name==='Onset Media Agency'),onsetDir=path.join(root,'tokkodev/analysis-output/onset-2026-09-17/messages');
 if(!live&&onset&&fs.existsSync(onsetDir))for(const file of fs.readdirSync(onsetDir).filter(f=>f.endsWith('.json'))){const h=read(path.join(onsetDir,file));for(const person of h.participants?.data||[])if(person.id!==onset.fb_page_id)entries.push({page:onset,psid:person.id,file:path.join(onsetDir,file),cutoff:h.fetchedAt,explicitFull:true});}
 const record=(entry)=>{
  if(!entry.page||!fs.existsSync(entry.file)){if(registryMode)throw Error('A registered calendar source is missing');return;}
  const key=entry.page.id+':'+entry.psid;if(seen.has(key))return;seen.add(key);
  const wrapperText=sourceText(entry.file),wrapper=JSON.parse(wrapperText),actualPath=wrapper.source_path?safePath(wrapper.source_path):entry.file,text=actualPath===entry.file?wrapperText:sourceText(actualPath),h=JSON.parse(text);
  if(entry.hash&&digest(text)!==entry.hash)throw Error('Retained calendar source changed since its registry audit');
  if(appliedSources.has(entry.page.id+':'+entry.psid+':'+digest(text))){report.already_reconciled++;return;}
  const complete=(wrapper.complete===true||entry.explicitFull===true)&&h.complete!==false;
  if(live&&!registryMode&&(h.psid!==entry.psid||h.fb_page_id!==entry.page.fb_page_id)||registryMode&&(h.psid&&h.psid!==entry.psid||h.fb_page_id&&h.fb_page_id!==entry.page.fb_page_id))throw Error('Collected source identity does not match its index');
  report.files++;report[complete?'complete':'partial']++;
  entry.cutoff||=h.source_cutoff_at;const cutoff=Date.parse(entry.cutoff);if(!Number.isFinite(cutoff))throw Error('Missing independently recorded source cutoff');
  const seq=[...new Map((h.messages||[]).map(m=>[m.id,m])).values()].map(m=>({raw:m,id:m.id,ms:Date.parse(m.created_time),text:String(m.message||'').normalize('NFKC'),sender:m.from?.id===entry.psid?'contact':m.from?.id===entry.page.fb_page_id?'page':'other',attachments:m.attachments?.data||[]})).filter(m=>typeof m.id==='string'&&Number.isFinite(m.ms)&&m.ms<=cutoff).sort((a,b)=>a.ms-b.ms||a.id.localeCompare(b.id)).map((m,i)=>({...m,i}));
  report.messages+=seq.length;const c=byIdentity.get(key);if(c)report.matched++;else report.unmatched++;
  const first=seq.find(m=>m.sender==='contact'&&!administrative(m.text)),stages=seq.map(m=>parseMessengerStageEvent(m.raw,entry.page.fb_page_id)).filter(Boolean);
  const acks=seq.flatMap(m=>{const signal=paymentSignal(m,seq);return signal?.confirmed&&m.sender==='page'&&['payment_ack','full_payment_ack'].includes(signal.kind)?[{id:m.id,at:new Date(m.ms).toISOString(),kind:signal.kind}]:[];});
  const page=report.pages[entry.page.name]??={files:0,messages:0,matched:0,unmatched:0,stage_events:0,missing_stage_events:0,first_date_differences:0,source_date_differences:0,new_page_acknowledgements:0};page.files++;page.messages+=seq.length;page[c?'matched':'unmatched']++;page.stage_events+=stages.length;
  report.stage_events+=stages.length;if(stages.length)report.with_stages++;
  const missing=stages.filter(e=>!stored.has(entry.page.id+':'+e.messageId));report.missing_stage_events+=missing.length;page.missing_stage_events+=missing.length;
  const firstMismatch=!!(c&&complete&&first&&Date.parse(c.first_interaction_at)!==first.ms),sourceMismatch=!!(c&&complete&&first&&Date.parse(c.first_inquiry_at)!==first.ms);
  if(firstMismatch){report.first_date_differences++;page.first_date_differences++;}if(sourceMismatch){report.source_date_differences++;page.source_date_differences++;}if(c&&first&&!c.first_inquiry_at)report.missing_sources++;
  if(c&&acks.length&&!c.payment_at){report.new_page_acknowledgements++;page.new_page_acknowledgements++;}
  if(c?.payment_evidence_id){const proof=seq.find(m=>m.id===c.payment_evidence_id);const signal=proof?paymentSignal(proof,seq):null,category=!proof?'missing_message':signal?.confirmed?'parser_confirmed_'+signal.kind:proof.sender==='contact'?'customer_receipt_or_claim':'needs_review';report.existing_payment_validation[category]=(report.existing_payment_validation[category]||0)+1;}
  let projectionCache=null;
  if(live&&c&&complete&&first){
   projectionCache=projectionCacheFromMessages(seq.map(m=>m.raw),{contactId:c.id,pageId:entry.page.id,facebookPageId:entry.page.fb_page_id,psid:entry.psid,cutoff,previous:c.previous_cache});
   if(registryMode)projectionCache.source_kind=entry.sourceKind;
   if(!projectionCache.complete_history)projectionCache=null;
   // Retain an independently reviewed receipt in the previous cache when its
   // exact source remains present. Text-only parsing must not erase that proof.
   if(projectionCache&&c.payment_at&&c.payment_evidence_id){const old=seq.find(m=>m.id===c.payment_evidence_id&&m.ms===Date.parse(c.payment_at)),signal=old?paymentSignal(old,seq):null;
    // An OCR-reviewed receipt/bill must retain its original provenance. A plain
    // Graph refresh cannot turn it into a newly verified Page acknowledgement.
    if(!old||old.sender!=='page'||!signal?.confirmed||!['payment_ack','full_payment_ack'].includes(signal.kind))projectionCache=null;
    else if(!projectionCache.payment_at||Date.parse(c.payment_at)<Date.parse(projectionCache.payment_at)){projectionCache.payment_at=new Date(c.payment_at).toISOString();projectionCache.payment_evidence_id=c.payment_evidence_id;}}
  }
  fs.writeSync(output,JSON.stringify({contact_id:c?.id||null,page_id:entry.page.id,fb_page_id:entry.page.fb_page_id,psid:entry.psid,complete,source_reviewed:live,source_cutoff_at:entry.cutoff,archive_path:path.relative(root,actualPath).replaceAll('\\','/'),archive_sha256:digest(text),first_inquiry_at:first?new Date(first.ms).toISOString():null,first_message_id:first?.id||null,latest_inbound_at:seq.findLast(m=>m.sender==='contact')?new Date(seq.findLast(m=>m.sender==='contact').ms).toISOString():null,stage_events:stages,page_acknowledgements:acks,projection_cache:projectionCache,first_date_mismatch:firstMismatch,source_date_mismatch:sourceMismatch,missing_stage_events:missing.length})+'\n');
 };
 for(const entry of entries){try{record(entry);}catch(e){report.errors.push({file:path.relative(root,entry.file),error:e.message});}if(report.files%1000===0){fs.writeFileSync(path.join(dir,'audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({files:report.files,messages:report.messages,missing_stages:report.missing_stage_events,errors:report.errors.length}));}}
 report.completed_at=new Date().toISOString();report.passed=report.errors.length===0;
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;await db.end().catch(()=>{});}finally{fs.closeSync(output);if(report.passed)fs.renameSync(temporaryManifest,path.join(dir,'manifest.jsonl'));fs.writeFileSync(path.join(dir,'audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
