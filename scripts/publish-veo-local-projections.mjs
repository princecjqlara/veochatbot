// Rebuild calendar inquiry/payment evidence and forecast features from the
// complete locally reviewed histories. Never calls a model or sends messages.
import fs from 'node:fs';import path from 'node:path';import {gunzipSync} from 'node:zlib';import {build} from 'esbuild';import {createRequire} from 'node:module';import pg from 'pg';
import {assertProjectCredentials,VEO_TARGET_PROJECT,digest} from './lib/database-migration-safety.mjs';
const apply=process.argv.includes('--apply');if(!apply&&!process.argv.includes('--preflight'))throw Error('Choose --apply or --preflight');
const {connectionString}=assertProjectCredentials(process.env,VEO_TARGET_PROJECT),dir=path.resolve('.vercel/veo-backlog');
const text=fs.readFileSync(path.join(dir,'prepared-manifest.jsonl'),'utf8'),hash=digest(text),records=text.split('\n').filter(Boolean).map(JSON.parse);
const published=JSON.parse(fs.readFileSync(path.join(dir,'local-publication-checkpoint.json'),'utf8'));if(published.manifest_sha256!==hash)throw Error('Profile publication manifest differs');
const from=Number(process.argv.find(a=>a.startsWith('--from='))?.slice(7)||0);if(!Number.isSafeInteger(from)||from<0||from>=records.length)throw Error('Invalid source offset');
let end=Math.min(records.length,published.next_offset);const suffix=from?'-from-'+from:'',stateFile=path.join(dir,'projection-checkpoint'+suffix+'.json'),prior=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
let offset=apply&&prior?.manifest_sha256===hash?prior.next_offset:from;
const bundle=path.join(dir,'projection-runtime.cjs');await build({stdin:{contents:"export {projectionCacheFromMessages} from './src/lib/contact-projection-refresh';export {verifyBacklogArtifact} from './src/lib/contact-backlog-analysis';",resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const {projectionCacheFromMessages,verifyBacklogArtifact}=createRequire(import.meta.url)(bundle);
const allowed=new Set(JSON.parse(fs.readFileSync('src/config/veo-pages.json','utf8')).map(p=>p.facebook_page_id).filter(Boolean));
const db=new pg.Client({connectionString,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:25000,query_timeout:120000});db.on('error',()=>{});
const report={pid:process.pid,target_project:VEO_TARGET_PROJECT,started_at:new Date().toISOString(),applied:apply,status:'processing',offset,manifest_sha256:hash,caches_saved:0,no_identifiable_inquiry:0,payment_acknowledgments:0,openrouter_calls:0,customer_messages_sent:0,errors:[]};
const flush=()=>fs.writeFileSync(path.join(dir,(apply?'projection-status':'projection-preflight')+suffix+'.json'),JSON.stringify(report,null,2));
try{
 await db.connect();flush();let limit=apply?end:Math.min(end,offset+100);
 const journalExists=(await db.query("SELECT to_regclass('app_private.veobot_local_projection_publications') IS NOT NULL AS found")).rows[0].found;
 const done=new Set((journalExists?(await db.query("SELECT c.page_id,c.psid,j.source_sha256 FROM app_private.veobot_local_projection_publications j JOIN contacts c ON c.id=j.contact_id")).rows:[]).map(r=>r.page_id+':'+r.psid+':'+r.source_sha256));
 if(apply&&process.argv.includes('--follow'))limit=records.length;
 while(offset<limit){
  if(apply&&process.argv.includes('--follow')){const current=JSON.parse(fs.readFileSync(path.join(dir,'local-publication-checkpoint.json'),'utf8'));if(current.manifest_sha256!==hash)throw Error('Profile manifest changed');end=Math.min(records.length,current.next_offset);if(offset>=end){report.status='waiting_for_profiles';flush();await new Promise(resolve=>setTimeout(resolve,3000));continue;}}
  const next=Math.min(limit,end,offset+300),rows=[];
  for(const entry of records.slice(offset,next)){
   if(done.has(entry.page_id+':'+entry.psid+':'+entry.source_sha256))continue;
   if(!entry.verified||!allowed.has(entry.facebook_page_id))throw Error('Profile outside approved VeoBot scope');const file=path.resolve(entry.artifact);if(!file.startsWith(dir+path.sep))throw Error('Profile escapes local archive');
   const bytes=fs.readFileSync(file);if(digest(bytes)!==entry.artifact_sha256)throw Error('Reviewed profile changed');const artifact=JSON.parse(gunzipSync(bytes));verifyBacklogArtifact(artifact);
   if(artifact.page_id!==entry.page_id||artifact.psid!==entry.psid||artifact.source_sha256!==entry.source_sha256)throw Error('Profile identity changed');
   const raw=artifact.messages.map(m=>({id:m.id,message:m.text,created_time:m.at,from:{id:m.sender==='customer'?entry.psid:m.sender==='page'?entry.facebook_page_id:'unknown'},attachments:{data:Array.from({length:m.images||0},()=>({image_data:{url:'attachment-present'}}))}}));
   let cache;try{cache=projectionCacheFromMessages(raw,{contactId:'00000000-0000-0000-0000-000000000000',pageId:entry.page_id,facebookPageId:entry.facebook_page_id,psid:entry.psid,cutoff:Date.parse(artifact.source_cutoff_at)});}catch(e){if(e.message!=='No identifiable customer inquiry in accessible history')throw e;report.no_identifiable_inquiry++;continue;}
   rows.push({page_id:entry.page_id,psid:entry.psid,source_sha256:entry.source_sha256,payload:cache});
  }
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='90s'");
  await db.query(`CREATE TABLE IF NOT EXISTS app_private.veobot_local_projection_publications(contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,source_sha256 text NOT NULL,published_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(contact_id,source_sha256));REVOKE ALL ON app_private.veobot_local_projection_publications FROM PUBLIC,anon,authenticated`);
  await db.query(`CREATE TEMP TABLE veo_projection_input ON COMMIT DROP AS SELECT c.id AS contact_id,i.* FROM jsonb_to_recordset($1::jsonb) AS i(page_id uuid,psid text,source_sha256 text,payload jsonb)
   JOIN contacts c ON c.page_id=i.page_id AND c.psid=i.psid
   WHERE EXISTS(SELECT 1 FROM app_private.contact_backlog_publications j WHERE j.contact_id=c.id AND j.source_sha256=i.source_sha256)
   AND NOT EXISTS(SELECT 1 FROM app_private.veobot_local_projection_publications j WHERE j.contact_id=c.id AND j.source_sha256=i.source_sha256)
   AND GREATEST(c.last_interaction_at,c.last_inbound_at)<=(i.payload->>'source_cutoff_at')::timestamptz
   AND NOT EXISTS(SELECT 1 FROM contact_conversion_cache f WHERE f.contact_id=c.id AND (f.source_cutoff_at>(i.payload->>'source_cutoff_at')::timestamptz
    OR f.first_inquiry_at<(i.payload->>'first_inquiry_at')::timestamptz AND f.first_message_id IS DISTINCT FROM i.payload->>'first_message_id')) FOR UPDATE OF c`,[JSON.stringify(rows)]);
  await db.query('SELECT public.save_contact_conversion_cache(page_id,contact_id,payload) FROM veo_projection_input');
  await db.query(`UPDATE contact_conversion_cache f SET source_kind='audited_history' FROM veo_projection_input i WHERE f.contact_id=i.contact_id AND f.source_cutoff_at=(i.payload->>'source_cutoff_at')::timestamptz`);
  await db.query(`UPDATE contacts c SET first_interaction_at=(i.payload->>'first_inquiry_at')::timestamptz FROM veo_projection_input i WHERE c.id=i.contact_id AND c.first_interaction_at IS DISTINCT FROM (i.payload->>'first_inquiry_at')::timestamptz`);
  await db.query(`UPDATE ad_contact_sources s SET inquiry_basis='audited_history' FROM veo_projection_input i WHERE s.contact_id=i.contact_id AND s.origin_ad_id IS NULL AND s.first_message_id=i.payload->>'first_message_id' AND s.first_inquiry_at=(i.payload->>'first_inquiry_at')::timestamptz`);
  await db.query('INSERT INTO app_private.veobot_local_projection_publications(contact_id,source_sha256) SELECT contact_id,source_sha256 FROM veo_projection_input');
  const result=(await db.query("SELECT count(*)::int AS n,count(*) FILTER(WHERE payload->>'payment_at' IS NOT NULL)::int AS paid FROM veo_projection_input")).rows[0];
  await db.query(apply?'COMMIT':'ROLLBACK');report.caches_saved+=result.n;report.payment_acknowledgments+=result.paid;offset=next;report.offset=offset;
  if(apply)fs.writeFileSync(stateFile,JSON.stringify({manifest_sha256:hash,next_offset:offset}));flush();
 }
 report.status=offset===records.length?'complete':'waiting_for_profiles';report.finished_at=new Date().toISOString();flush();console.log(JSON.stringify(report));
}catch(e){await db.query('ROLLBACK').catch(()=>{});report.status='retry_needed';report.errors.push({offset,error:e.message,code:e.code});flush();console.error(JSON.stringify(report));process.exitCode=1;}finally{await db.end();}
