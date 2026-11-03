// Refresh only explicitly audited, missing/newer histories into the local
// archive, review them locally and publish complete source-cited profiles.
import fs from 'node:fs';import path from 'node:path';import {gzipSync,gunzipSync} from 'node:zlib';import {build} from 'esbuild';import {createRequire} from 'node:module';import pg from 'pg';
import {assertProjectCredentials,VEO_TARGET_PROJECT,digest} from './lib/database-migration-safety.mjs';import {localPublicationRow,publishLocalBatch} from './lib/veo-local-publication.mjs';
const {connectionString}=assertProjectCredentials(process.env,VEO_TARGET_PROJECT),dir=path.resolve('.vercel/veo-backlog/refreshed');fs.mkdirSync(dir,{recursive:true});
const auditFile=process.argv.find(a=>a.startsWith('--audit='))?.slice(8)||'.vercel/veo-reset/completion-audit.json';const audit=JSON.parse(fs.readFileSync(auditFile,'utf8'));
if(audit.target_project!==VEO_TARGET_PROJECT||!Array.isArray(audit.missing_profiles)||audit.missing_profiles.length>100)throw Error('A bounded target audit is required');
const approved=new Set(JSON.parse(fs.readFileSync('src/config/veo-pages.json','utf8')).map(p=>p.facebook_page_id).filter(Boolean));
const bundle=path.join(dir,'runtime.cjs');await build({stdin:{contents:"export * from './src/lib/contact-backlog-analysis';export {normalizeContactName} from './src/lib/contact-names';export {projectionCacheFromMessages} from './src/lib/contact-projection-refresh';",resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const {analyzeContactBacklog,verifyBacklogArtifact,BACKLOG_ANALYSIS_VERSION,normalizeContactName,projectionCacheFromMessages}=createRequire(import.meta.url)(bundle);
const db=new pg.Client({connectionString,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:25000,query_timeout:120000});db.on('error',()=>{});
const report={target_project:VEO_TARGET_PROJECT,started_at:new Date().toISOString(),reviewed:0,published:0,skipped:[],errors:[],openrouter_calls:0,customer_messages_sent:0};
try{
 await db.connect();
 for(const item of audit.missing_profiles){
  try{
   const contact=(await db.query('SELECT c.*,p.fb_page_id,p.access_token FROM contacts c JOIN pages p ON p.id=c.page_id WHERE c.page_id=$1 AND c.psid=$2',[item.page_id,item.psid])).rows[0];
   if(!contact||!approved.has(contact.fb_page_id)||contact.fb_page_id!==item.facebook_page_id)throw Error('Contact/Page identity is unverified');
   const config=(await db.query('SELECT details_to_collect,commercial_video_intake_enabled FROM chatbot_configs WHERE page_id=$1',[item.page_id])).rows[0];
   const cutoff=new Date().toISOString();
   const read=async value=>{const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='graph.facebook.com')throw Error('Untrusted Messenger cursor');url.searchParams.delete('access_token');const r=await fetch(url,{headers:{Authorization:'Bearer '+contact.access_token},signal:AbortSignal.timeout(15000)}),b=await r.json();if(!r.ok||b.error)throw Object.assign(Error('Messenger history unavailable'),{code:b.error?.code||r.status});return b;};
   const query=new URL('https://graph.facebook.com/v24.0/'+contact.fb_page_id+'/conversations');query.searchParams.set('user_id',contact.psid);query.searchParams.set('limit','1');query.searchParams.set('fields','id,messages.limit(100){id,message,from,created_time,attachments{mime_type,image_data}}');
   const conversation=(await read(query)).data?.[0];if(!Array.isArray(conversation?.messages?.data))throw Error('No complete readable conversation');
   const messages=[...conversation.messages.data],seen=new Set();let next=conversation.messages.paging?.next;
   while(next){if(seen.has(next)||messages.length>50000)throw Error('Messenger pagination is incomplete');seen.add(next);const page=await read(next);if(!Array.isArray(page.data))throw Error('Incomplete message page');messages.push(...page.data);next=page.paging?.next;}
   const original=JSON.stringify({page_id:item.page_id,facebook_page_id:contact.fb_page_id,psid:contact.psid,source_cutoff_at:cutoff,complete:true,messages});const sourceHash=digest(original),sourceFile=path.join(dir,item.page_id+'-'+contact.psid+'-'+sourceHash+'.source.json.gz');fs.writeFileSync(sourceFile,gzipSync(original));
   const analysis=analyzeContactBacklog({pageId:item.page_id,facebookPageId:contact.fb_page_id,psid:contact.psid,cutoff,messages,requestedFields:Array.isArray(config?.details_to_collect)?config.details_to_collect:[],commercialVideo:config?.commercial_video_intake_enabled===true});
   const artifact={...analysis,engine:BACKLOG_ANALYSIS_VERSION,page_id:item.page_id,facebook_page_id:contact.fb_page_id,psid:contact.psid,prepared_at:new Date().toISOString(),processing_complete:true,source_sha256:sourceHash,source_cutoff_at:cutoff,source_kind:'local_graph_refresh',source_archive:path.relative(path.resolve('..'),sourceFile)};
   verifyBacklogArtifact(artifact);const artifactFile=sourceFile.replace('.source.json.gz','.profile.json.gz');fs.writeFileSync(artifactFile,gzipSync(JSON.stringify(artifact)));report.reviewed++;
   if(digest(gunzipSync(fs.readFileSync(sourceFile)).toString('utf8'))!==sourceHash)throw Error('Saved conversation fingerprint changed');
   const row=localPublicationRow(artifact,contact,normalizeContactName);if(!row){report.skipped.push({page_id:item.page_id,status:'no_customer_history'});continue;}
   const result=await publishLocalBatch(db,[row],true);report.published+=result.published;if(!result.published)report.skipped.push({page_id:item.page_id,status:'newer_activity_retained'});
   fs.appendFileSync(path.join(dir,'prepared-manifest.jsonl'),JSON.stringify({page_id:item.page_id,psid:contact.psid,artifact:artifactFile,artifact_sha256:digest(fs.readFileSync(artifactFile)),source_sha256:sourceHash,source_cutoff_at:cutoff,published:result.published===1})+'\n');
   if(result.published){
    const cache=projectionCacheFromMessages(messages,{contactId:contact.id,pageId:contact.page_id,facebookPageId:contact.fb_page_id,psid:contact.psid,cutoff:Date.parse(cutoff)});
    await db.query('SELECT public.save_contact_conversion_cache($1,$2,$3::jsonb)',[contact.page_id,contact.id,JSON.stringify(cache)]);
   }
  }catch(e){report.errors.push({page_id:item.page_id,error:e.message,code:e.code});}
  fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));
 }
 report.finished_at=new Date().toISOString();fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(report.errors.length)process.exitCode=1;
}finally{await db.end();}
