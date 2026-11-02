// Prepare durable source-cited profiles locally. No network or model calls.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {gzipSync,gunzipSync} from 'node:zlib';import {createRequire} from 'node:module';import {build} from 'esbuild';
const root=path.resolve('..'),dir=path.resolve('.vercel/backlog-analysis'),profiles=path.join(dir,'profiles');fs.mkdirSync(profiles,{recursive:true});
const scopeReport=JSON.parse(fs.readFileSync('.vercel/system-data-audit/coverage.json','utf8'));
const pageIds=new Set(scopeReport.pages.filter(page=>['last_reported_readable','last_scan_incomplete'].includes(page.scope_status)).map(page=>page.page_id));
const registryFile=path.resolve(process.argv.find(arg=>arg.startsWith('--registry='))?.slice(11)||'.vercel/system-data-audit/latest-sources.jsonl');
if(!registryFile.startsWith(path.resolve('.vercel')+path.sep))throw Error('Registry must be inside the ignored workspace audit directory');
const registry=fs.readFileSync(registryFile,'utf8'),records=registry.split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>pageIds.has(row.page_id));
const limit=Number(process.argv.find(arg=>arg.startsWith('--limit='))?.slice(8)||records.length);if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid analysis limit');
const bundle=path.join(dir,'analysis-runtime.cjs');await build({entryPoints:['src/lib/contact-backlog-analysis.ts'],outfile:bundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const {analyzeContactBacklog,verifyBacklogArtifact,BACKLOG_ANALYSIS_VERSION}=createRequire(import.meta.url)(bundle);
const status={pid:process.pid,started_at:new Date().toISOString(),status:'analyzing_saved_sources',scope:'last_known_connected_pages',connection_scope_verified_live:false,scope_snapshot_at:scopeReport.recorded_database_snapshot_at,engine:BACKLOG_ANALYSIS_VERSION,registry_sha256:crypto.createHash('sha256').update(registry).digest('hex'),eligible_sources:records.length,run_limit:limit,processed:0,newly_analyzed:0,reused_prepared_profiles:0,messages_analyzed:0,citations_verified:0,profiles_with_explicit_answers:0,answer_events:0,unique_question_texts:0,stage_events:0,chat_payment_acknowledgments:0,profiles_needing_review:0,errors:[],ai_calls:0,openrouter_calls:0,ai_jobs_queued:0,customer_messages_sent:0,database_profiles_published:0};
const atomic=(file,value)=>{const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,value);fs.renameSync(tmp,file);};
const flush=()=>atomic(path.join(dir,'status.json'),JSON.stringify({...status,updated_at:new Date().toISOString()},null,2));
const configMap=new Map();
for(const file of ['.vercel/conversation-data-audit/config-baseline.json','.vercel/pricing-config-backup.json'])if(fs.existsSync(file)){const value=JSON.parse(fs.readFileSync(file,'utf8'));const rows=Array.isArray(value)?value:Array.isArray(value.configs)?value.configs:[];for(const row of rows)if(row.page_id)configMap.set(row.page_id,{requestedFields:Array.isArray(row.details_to_collect)?row.details_to_collect.filter(field=>typeof field==='string'):[],commercialVideo:row.commercial_video_intake_enabled===true});}
const output=fs.openSync(path.join(dir,'prepared-manifest.jsonl.tmp'),'w');flush();
try{
 for(const row of records.slice(0,limit)){
  try{
   if(!/^[0-9a-f-]{36}$/.test(row.page_id)||!/^\d+$/.test(row.psid)||!/^\d+$/.test(row.fb_page_id)||!row.complete||!Number.isFinite(Date.parse(row.source_cutoff_at))||! /^[0-9a-f]{64}$/.test(row.archive_sha256))throw Error('Invalid source registry identity or cutoff');
   const pageDir=path.join(profiles,row.page_id);fs.mkdirSync(pageDir,{recursive:true});const file=path.join(pageDir,row.psid+'-'+row.archive_sha256+'-'+BACKLOG_ANALYSIS_VERSION+'.json.gz');
   let prepared,verified,artifactHash;
   if(fs.existsSync(file)){const compressed=fs.readFileSync(file),cached=JSON.parse(gunzipSync(compressed).toString('utf8'));if(cached.source_sha256===row.archive_sha256&&cached.engine===BACKLOG_ANALYSIS_VERSION&&cached.page_id===row.page_id&&cached.psid===row.psid&&cached.processing_complete){prepared=cached;verified=verifyBacklogArtifact(prepared);artifactHash=crypto.createHash('sha256').update(compressed).digest('hex');status.reused_prepared_profiles++;}}
   if(!prepared){const source=path.resolve(root,row.archive_path);if(!source.startsWith(root+path.sep))throw Error('Source path escapes workspace');const bytes=fs.readFileSync(source),text=(source.endsWith('.gz')?gunzipSync(bytes).toString('utf8'):bytes.toString('utf8')).replace(/^\uFEFF/,'');if(crypto.createHash('sha256').update(text).digest('hex')!==row.archive_sha256)throw Error('Source changed since the registry was verified');
    const history=JSON.parse(text),analysis=analyzeContactBacklog({pageId:row.page_id,facebookPageId:row.fb_page_id,psid:row.psid,cutoff:row.source_cutoff_at,messages:history.messages,...configMap.get(row.page_id)});
    prepared={engine:BACKLOG_ANALYSIS_VERSION,prepared_at:new Date().toISOString(),processing_complete:true,page_id:row.page_id,facebook_page_id:row.fb_page_id,psid:row.psid,source_sha256:row.archive_sha256,source_cutoff_at:row.source_cutoff_at,source_kind:row.source_kind,source_archive:row.archive_path,...analysis};
    verified=verifyBacklogArtifact(prepared);const compressed=gzipSync(JSON.stringify(prepared));artifactHash=crypto.createHash('sha256').update(compressed).digest('hex');atomic(file,compressed);status.newly_analyzed++;
   }
   const p=prepared.payload;status.processed++;status.messages_analyzed+=prepared.messages.length;status.citations_verified+=verified.citations_checked;status.profiles_with_explicit_answers+=Number(p.extracted_answers.length>0);status.answer_events+=p.answer_history.length;status.unique_question_texts+=p.conversation.unique_question_count;status.stage_events+=p.stage_events.length;status.chat_payment_acknowledgments+=p.conversation.payment_evidence.filter(event=>event.acknowledgment).length;status.profiles_needing_review+=Number(p.review_reasons.length>0);
   fs.writeSync(output,JSON.stringify({page_id:row.page_id,psid:row.psid,facebook_page_id:row.fb_page_id,source_sha256:row.archive_sha256,source_cutoff_at:row.source_cutoff_at,engine:BACKLOG_ANALYSIS_VERSION,artifact:path.relative(process.cwd(),file),artifact_sha256:artifactHash,verified:true,message_count:prepared.messages.length,needs_review:p.review_reasons.length>0})+'\n');
  }catch(error){status.errors.push({source_number:status.processed+status.errors.length+1,page_id:row.page_id,error:error.message});}
  if((status.processed+status.errors.length)%1000===0){flush();console.log(JSON.stringify({processed:status.processed,eligible:records.length,messages:status.messages_analyzed,errors:status.errors.length}));await new Promise(resolve=>setTimeout(resolve,0));}
 }
 status.status=status.errors.length?'prepared_with_review_errors':limit<records.length?'sample_prepared':'prepared_saved_sources';status.completed_at=new Date().toISOString();
}catch(error){status.status='interrupted';status.fatal_error=error.message;process.exitCode=1;}
finally{fs.closeSync(output);fs.renameSync(path.join(dir,'prepared-manifest.jsonl.tmp'),path.join(dir,'prepared-manifest.jsonl'));flush();console.log(JSON.stringify(status,null,2));}
