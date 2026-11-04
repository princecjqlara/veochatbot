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
 const prepare=async item=>{try{
   const contact=(await db.query('SELECT c.*,p.fb_page_id,p.access_token FROM contacts c JOIN pages p ON p.id=c.page_id WHERE c.page_id=$1 AND c.psid=$2',[item.page_id,item.psid])).rows[0];
   if(!contact||!approved.has(contact.fb_page_id)||contact.fb_page_id!==item.facebook_page_id)throw Error('Contact/Page identity is unverified');
   const config=(await db.query('SELECT details_to_collect,commercial_video_intake_enabled FROM chatbot_configs WHERE page_id=$1',[item.page_id])).rows[0];
   let cutoff=new Date().toISOString(),sourceMode='live_graph',messages;
   const read=async value=>{const url=new URL(value);if(url.protocol!=='https:'||url.hostname!=='graph.facebook.com')throw Error('Untrusted Messenger cursor');url.searchParams.delete('access_token');const r=await fetch(url,{headers:{Authorization:'Bearer '+contact.access_token},signal:AbortSignal.timeout(15000)}),b=await r.json();if(!r.ok||b.error)throw Object.assign(Error('Messenger history unavailable'),{code:b.error?.code||r.status});return b;};
   const query=new URL('https://graph.facebook.com/v24.0/'+contact.fb_page_id+'/conversations');query.searchParams.set('user_id',contact.psid);query.searchParams.set('limit','1');query.searchParams.set('fields','id,messages.limit(100){id,message,from,created_time,attachments{mime_type,image_data}}');
    const readVerifiedArchive=async()=>{
    const snapshot=(await db.query(`SELECT source_cutoff_at,payload FROM contact_profile_snapshots
      WHERE contact_id=$1 AND page_id=$2 ORDER BY generation DESC LIMIT 1`,[contact.id,contact.page_id])).rows[0];
    const priorHash=snapshot?.payload?.source_sha256;
    if(!/^\d+$/.test(contact.psid))return null;
    const prefix=item.page_id+'-'+contact.psid+'-',suffix='.source.json.gz';
    const candidates=fs.readdirSync(dir).filter(name=>name.startsWith(prefix)&&name.endsWith(suffix))
     .sort((a,b)=>Number(b===prefix+priorHash+suffix)-Number(a===prefix+priorHash+suffix));
    for(const name of candidates)try{
     const hash=name.slice(prefix.length,-suffix.length);
     if(!/^[a-f0-9]{64}$/.test(hash))continue;
     const text=gunzipSync(fs.readFileSync(path.join(dir,name))).toString('utf8'),prior=JSON.parse(text),priorCutoff=Date.parse(prior.source_cutoff_at);
     if(digest(text)!==hash||prior.complete!==true||prior.page_id!==item.page_id||prior.facebook_page_id!==contact.fb_page_id
      ||prior.psid!==contact.psid||!Array.isArray(prior.messages)||!Number.isFinite(priorCutoff)
      ||contact.last_interaction_at&&Date.parse(contact.last_interaction_at)>priorCutoff||contact.last_inbound_at&&Date.parse(contact.last_inbound_at)>priorCutoff)continue;
     return prior;
    }catch{}
    return null;
    };
    let archiveHistory=await readVerifiedArchive();
    if(archiveHistory){cutoff=new Date(archiveHistory.source_cutoff_at).toISOString();sourceMode='verified_local_archive';messages=archiveHistory.messages;}
    else try{
     const conversation=(await read(query)).data?.[0];if(!Array.isArray(conversation?.messages?.data))throw Error('No complete readable conversation');
     messages=[...conversation.messages.data];const seen=new Set();let next=conversation.messages.paging?.next;
     while(next){if(seen.has(next)||messages.length>50000)throw Error('Messenger pagination is incomplete');seen.add(next);const page=await read(next);if(!Array.isArray(page.data))throw Error('Incomplete message page');messages.push(...page.data);next=page.paging?.next;}
    }catch(graphError){
     archiveHistory=await readVerifiedArchive();
     if(archiveHistory){cutoff=new Date(archiveHistory.source_cutoff_at).toISOString();sourceMode='verified_local_archive';messages=archiveHistory.messages;}
     else{
    // Meta may no longer expose an older thread even though this system has a
    // previously completed local copy. Reuse it only when the saved job and
    // exact message count prove the archived history was complete.
    const saved=(await db.query(`SELECT j.working_version,j.source_cutoff_at,j.message_count,j.analyzed_count,j.history_complete,
      count(m.message_id)::int AS saved_count
     FROM contact_profile_jobs j LEFT JOIN contact_profile_messages m
      ON m.contact_id=j.contact_id AND m.page_id=j.page_id AND m.generation=j.working_version
     WHERE j.contact_id=$1 AND j.page_id=$2 GROUP BY j.working_version,j.source_cutoff_at,j.message_count,j.analyzed_count,j.history_complete`,[contact.id,contact.page_id])).rows[0];
    if(!saved?.history_complete||!saved.message_count||saved.analyzed_count!==saved.message_count||saved.saved_count!==saved.message_count)throw graphError;
    const archived=(await db.query(`SELECT message_id,sent_at,sender,text,attachment_count,image_count FROM contact_profile_messages
      WHERE contact_id=$1 AND page_id=$2 AND generation=$3 ORDER BY sent_at,message_id`,[contact.id,contact.page_id,saved.working_version])).rows;
    if(archived.length!==saved.message_count)throw graphError;
    cutoff=new Date(saved.source_cutoff_at).toISOString();sourceMode='complete_saved_history';
    messages=archived.map(m=>({id:m.message_id,created_time:new Date(m.sent_at).toISOString(),message:m.text||'',
      from:{id:m.sender==='customer'?contact.psid:m.sender==='page'?contact.fb_page_id:'unknown'},
      attachments:{data:Array.from({length:m.attachment_count||0},(_,i)=>({mime_type:i<(m.image_count||0)?'image/unknown':'application/unknown'}))}}));
    }
   }
   const original=JSON.stringify({page_id:item.page_id,facebook_page_id:contact.fb_page_id,psid:contact.psid,source_cutoff_at:cutoff,complete:true,source_mode:sourceMode,messages});const sourceHash=digest(original),sourceFile=path.join(dir,item.page_id+'-'+contact.psid+'-'+sourceHash+'.source.json.gz');fs.writeFileSync(sourceFile,gzipSync(original));
   const analysis=analyzeContactBacklog({pageId:item.page_id,facebookPageId:contact.fb_page_id,psid:contact.psid,cutoff,messages,requestedFields:Array.isArray(config?.details_to_collect)?config.details_to_collect:[],commercialVideo:config?.commercial_video_intake_enabled===true});
   const artifact={...analysis,engine:BACKLOG_ANALYSIS_VERSION,page_id:item.page_id,facebook_page_id:contact.fb_page_id,psid:contact.psid,prepared_at:new Date().toISOString(),processing_complete:true,source_sha256:sourceHash,source_cutoff_at:cutoff,source_kind:sourceMode==='live_graph'?'local_graph_refresh':'local_saved_history_refresh',source_archive:path.relative(path.resolve('..'),sourceFile)};
   verifyBacklogArtifact(artifact);const artifactFile=sourceFile.replace('.source.json.gz','.profile.json.gz');fs.writeFileSync(artifactFile,gzipSync(JSON.stringify(artifact)));report.reviewed++;
   if(digest(gunzipSync(fs.readFileSync(sourceFile)).toString('utf8'))!==sourceHash)throw Error('Saved conversation fingerprint changed');
   return{item,contact,cutoff,messages,artifact,artifactFile};
  }catch(error){return{item,error};}};
 for(let offset=0;offset<audit.missing_profiles.length;offset+=4){
  // Fetch and analyze multiple independent histories at once. Database
  // publication remains sequential so each batch uses the existing advisory
  // lock and cannot race another local publisher.
  const prepared=await Promise.all(audit.missing_profiles.slice(offset,offset+4).map(prepare));
  for(const result of prepared){
   try{
    if(result.error)throw result.error;
    const{item,contact,cutoff,messages,artifact,artifactFile}=result;
    const row=localPublicationRow(artifact,contact,normalizeContactName);
    if(!row){report.skipped.push({page_id:item.page_id,status:'no_customer_history'});continue;}
    const published=await publishLocalBatch(db,[row],true);report.published+=published.published;if(!published.published)report.skipped.push({page_id:item.page_id,status:'newer_activity_retained'});
    fs.appendFileSync(path.join(dir,'prepared-manifest.jsonl'),JSON.stringify({page_id:item.page_id,psid:contact.psid,artifact:artifactFile,artifact_sha256:digest(fs.readFileSync(artifactFile)),source_sha256:artifact.source_sha256,source_cutoff_at:cutoff,published:published.published===1})+'\n');
    if(published.published){const cache=projectionCacheFromMessages(messages,{contactId:contact.id,pageId:contact.page_id,facebookPageId:contact.fb_page_id,psid:contact.psid,cutoff:Date.parse(cutoff)});await db.query('SELECT public.save_contact_conversion_cache($1,$2,$3::jsonb)',[contact.page_id,contact.id,JSON.stringify(cache)]);}
   }catch(error){report.errors.push({page_id:result.item.page_id,error:error.message,code:error.code});}
   fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));
  }
 }
 report.finished_at=new Date().toISOString();fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(report.errors.length)process.exitCode=1;
}finally{await db.end();}
