// Import already prepared profiles. Never invokes OpenRouter or queues AI work.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {gunzipSync} from 'node:zlib';import {createRequire} from 'node:module';import {build} from 'esbuild';import pg from 'pg';
import {connectedPageScope} from './lib/connected-pages.mjs';import {backlogPublicationJournalSql,publishBacklogProfile} from './lib/backlog-profile-publication.mjs';
const apply=process.argv.includes('--apply');if(Number(apply)+Number(process.argv.includes('--preflight'))!==1)throw Error('Choose --preflight or --apply');
const dir=path.resolve('.vercel/backlog-analysis'),root=path.resolve('..'),manifestFile=path.join(dir,'prepared-manifest.jsonl');
const limit=Number(process.argv.find(arg=>arg.startsWith('--limit='))?.slice(8)||100);if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('Choose up to 1000 profiles per publication pass');
const report={started_at:new Date().toISOString(),scope:'connected_pages',applied:apply,considered:0,published:0,preflight_passed:0,skipped:{},errors:[],openrouter_calls:0,ai_jobs_queued:0,customer_messages_sent:0,financial_records_created:0};
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:7000,query_timeout:35000});db.on('error',()=>{});
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
try{
 if(!fs.existsSync(manifestFile)){report.status='waiting_for_prepared_profiles';}else{
  const text=fs.readFileSync(manifestFile,'utf8'),hash=digest(text),records=text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const expected=process.argv.find(arg=>arg.startsWith('--expected-manifest='))?.slice(20);if(expected&&hash!==expected)throw Error('Prepared manifest changed after preflight');
  const status=JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8'));if(!['prepared_saved_sources','prepared_with_review_errors'].includes(status.status))throw Error('The analysis pass must finish before its manifest is published');
  const bundle=path.join(dir,'publication-runtime.cjs');await build({entryPoints:['src/lib/contact-backlog-analysis.ts'],outfile:bundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});const {verifyBacklogArtifact,BACKLOG_ANALYSIS_VERSION}=createRequire(import.meta.url)(bundle);
  await db.connect();const pages=(await db.query('SELECT p.id,p.name,p.fb_page_id,p.access_token FROM pages p WHERE EXISTS(SELECT 1 FROM user_pages u WHERE u.page_id=p.id) ORDER BY p.name')).rows;
  const scope=await connectedPageScope(pages,async page=>{const response=await fetch('https://graph.facebook.com/v24.0/'+page.fb_page_id+'/conversations?fields=id&limit=1',{headers:{Authorization:'Bearer '+page.access_token},signal:AbortSignal.timeout(8000)}),body=await response.json();if(!response.ok||body.error)throw Object.assign(Error('Page connection could not be verified'),{code:body.error?.code||response.status});return body;});
  report.disconnected_pages_excluded=scope.excluded;report.unverified_pages=scope.unverified;const allowed=new Set(scope.connected.map(page=>page.id));
  if(apply){await db.query('BEGIN');await db.query(backlogPublicationJournalSql);await db.query('COMMIT');}
  const journalExists=(await db.query("SELECT to_regclass('app_private.contact_backlog_publications') IS NOT NULL AS found")).rows[0].found;
  const done=new Set((journalExists?(await db.query('SELECT page_id,psid,engine,source_sha256 FROM app_private.contact_backlog_publications')).rows:[]).map(row=>[row.page_id,row.psid,row.engine,row.source_sha256].join(':')));
  report.manifest_sha256=hash;report.engine=BACKLOG_ANALYSIS_VERSION;
  const positionFile=path.join(dir,'publication-position.json'),position=fs.existsSync(positionFile)?JSON.parse(fs.readFileSync(positionFile,'utf8')):null;
  let offset=apply&&position?.manifest_sha256===hash?position.next_offset:0;
  for(;offset<records.length&&report.considered<limit;offset++){
   const row=records[offset];if(!allowed.has(row.page_id)||done.has([row.page_id,row.psid,row.engine,row.source_sha256].join(':')))continue;report.considered++;
   try{
    if(row.engine!==BACKLOG_ANALYSIS_VERSION||row.verified!==true||!/^[0-9a-f]{64}$/.test(row.artifact_sha256||''))throw Error('Prepared profile is not sealed for the current extraction engine');
    const file=path.resolve(row.artifact);if(!file.startsWith(dir+path.sep))throw Error('Prepared profile escapes its archive');const bytes=fs.readFileSync(file);if(digest(bytes)!==row.artifact_sha256)throw Error('Prepared profile changed after citation verification');
    const artifact=JSON.parse(gunzipSync(bytes).toString('utf8'));verifyBacklogArtifact(artifact);
    if(artifact.page_id!==row.page_id||artifact.psid!==row.psid||artifact.facebook_page_id!==row.facebook_page_id||artifact.source_cutoff_at!==row.source_cutoff_at||artifact.source_sha256!==row.source_sha256)throw Error('Prepared profile identity changed');
    const source=path.resolve(root,artifact.source_archive);if(!source.startsWith(root+path.sep))throw Error('Original source escapes the workspace');const raw=fs.readFileSync(source),original=(source.endsWith('.gz')?gunzipSync(raw).toString('utf8'):raw.toString('utf8')).replace(/^\uFEFF/,'');if(digest(original)!==artifact.source_sha256)throw Error('Original history changed after profile preparation');
    const result=await publishBacklogProfile(db,artifact,apply);if(result.status==='published')report.published++;else if(result.status==='preflight_passed')report.preflight_passed++;else report.skipped[result.status]=(report.skipped[result.status]||0)+1;
   }catch(error){report.errors.push({source_number:offset+1,error:error.message});}
  }
  if(apply)fs.writeFileSync(positionFile,JSON.stringify({manifest_sha256:hash,next_offset:offset>=records.length?0:offset,updated_at:new Date().toISOString()},null,2));
  report.status='publication_pass_finished';report.remaining_manifest_entries=Math.max(0,records.length-offset);report.passed=report.errors.length===0;report.completed_at=new Date().toISOString();if(!report.passed)process.exitCode=1;
 }
}catch(error){report.status='waiting_for_database_or_review';report.error=error.message;report.passed=false;process.exitCode=1;}
finally{await Promise.race([db.end().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1000))]);fs.writeFileSync(path.join(dir,'publish-'+(apply?'apply':'preflight')+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
