// Preserve original object bytes. SQL row backups alone do not include Storage.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import pg from 'pg';
import {assertProjectCredentials,LEGACY_SOURCE_PROJECT} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
const dir=path.resolve('.vercel/database-migration');
const status=JSON.parse(fs.readFileSync(path.join(dir,'account-backup-status.json'),'utf8'));
const backupFile=path.resolve(status.manifest),backup=JSON.parse(fs.readFileSync(backupFile,'utf8'));
if(backup.source_project!==LEGACY_SOURCE_PROJECT||!backup.pages?.length)throw Error('A scoped source snapshot is required');
const endpoint=assertProjectCredentials(process.env,LEGACY_SOURCE_PROJECT);
const destination=path.join(path.dirname(backupFile),'storage');fs.mkdirSync(destination,{recursive:true});
const priorFile=path.join(destination,'manifest.json'),prior=fs.existsSync(priorFile)?JSON.parse(fs.readFileSync(priorFile,'utf8')):null;
const report={source_backup_run_id:backup.run_id,source_project:LEGACY_SOURCE_PROJECT,started_at:new Date().toISOString(),passed:false,source_database_writes:0,openrouter_calls:0,customer_messages_sent:0,objects:[]};
const flush=()=>{fs.writeFileSync(path.join(destination,'manifest.json.tmp'),JSON.stringify(report,null,2));fs.renameSync(path.join(destination,'manifest.json.tmp'),path.join(destination,'manifest.json'));};
const db=new pg.Client({...await migrationConnectionOptions(endpoint.connectionString),connectionTimeoutMillis:30000,query_timeout:60000,statement_timeout:60000});db.on('error',()=>{});
const api=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(60000)})}});
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL lock_timeout='5s'");
 report.inventory_at=(await db.query('SELECT transaction_timestamp() AS at')).rows[0].at;
 report.buckets=(await db.query('SELECT id,name,public,file_size_limit,allowed_mime_types FROM storage.buckets ORDER BY id')).rows;
 const objects=(await db.query(`SELECT o.id,o.bucket_id,o.name,o.metadata,o.created_at,o.updated_at FROM storage.objects o
  WHERE (o.bucket_id IN ('chatbot-media','messenger-agent-media','photo-headers') AND split_part(o.name,'/',2)=ANY($1::text[]))
  OR EXISTS(SELECT 1 FROM public.chatbot_media_assets m WHERE m.page_id=ANY($2::uuid[]) AND m.storage_bucket=o.bucket_id AND m.storage_path=o.name)
  OR (o.bucket_id='conversation-exports' AND EXISTS(SELECT 1 FROM public.conversation_export_jobs j WHERE j.page_id=ANY($2::uuid[]) AND starts_with(o.name,j.storage_prefix||'/')))
  ORDER BY o.bucket_id,o.name`,[backup.pages.map(p=>p.id),backup.pages.map(p=>p.id)])).rows;
 report.inventory=objects;report.expected_objects=objects.length;
 await db.query('ROLLBACK');flush();
 for(const object of objects){
  report.current_object={bucket:object.bucket_id,path:object.name};flush();
  const saved=prior?.source_backup_run_id===backup.run_id&&prior.objects.find(o=>o.id===object.id&&new Date(o.updated_at).valueOf()===new Date(object.updated_at).valueOf());
  if(saved&&saved.file===saved.sha256+'.bin'&&/^[a-f0-9]{64}$/.test(saved.sha256)&&fs.existsSync(path.join(destination,saved.file))){
   const content=fs.readFileSync(path.join(destination,saved.file));
   if(content.length===saved.bytes&&createHash('sha256').update(content).digest('hex')===saved.sha256){report.objects.push(saved);flush();continue;}
  }
  let bytes,lastError;
  for(let attempt=1;attempt<=3;attempt++){
   try{const {data,error}=await api.storage.from(object.bucket_id).download(object.name);if(error||!data)throw error||Error('Source object is unavailable');bytes=Buffer.from(await data.arrayBuffer());break;}
   catch(error){lastError=error;report.last_download_error={attempt,name:error.name,status:error.status||error.statusCode||error.originalError?.status||null};flush();if(attempt<3)await new Promise(resolve=>setTimeout(resolve,attempt*2000));}
  }
  if(!bytes)throw lastError;
  if(object.metadata?.size!==undefined&&BigInt(bytes.length)!==BigInt(object.metadata.size))throw Error('Source object size changed during preservation');
  const sha256=createHash('sha256').update(bytes).digest('hex'),file=sha256+'.bin';
  if(!fs.existsSync(path.join(destination,file)))fs.writeFileSync(path.join(destination,file),bytes,{flag:'wx'});
  const current=(await db.query('SELECT updated_at FROM storage.objects WHERE id=$1',[object.id])).rows[0];
  if(!current||new Date(current.updated_at).valueOf()!==new Date(object.updated_at).valueOf())throw Error('Source object changed during download; retry the snapshot');
  report.objects.push({...object,file,sha256,bytes:bytes.length});flush();
 }
 for(const object of report.objects){const content=fs.readFileSync(path.join(destination,object.file));if(content.length!==object.bytes||createHash('sha256').update(content).digest('hex')!==object.sha256)throw Error('Saved source object checksum differs');}
 delete report.current_object;delete report.last_download_error;
 report.passed=report.objects.length===report.expected_objects;report.completed_at=new Date().toISOString();report.total_bytes=report.objects.reduce((n,o)=>n+o.bytes,0);flush();
 console.log(JSON.stringify({passed:true,source_backup_run_id:backup.run_id,objects:report.objects.length,bytes:report.total_bytes}));
}catch(error){await db.query('ROLLBACK').catch(()=>{});report.error=String(error.message||error).replace(/postgres(?:ql)?:\/\/\S+|eyJ[\w.-]+|EA[\w-]{25,}/g,'[redacted]');flush();console.error(JSON.stringify({passed:false,error:report.error}));process.exitCode=1;}
finally{await db.end().catch(()=>{});}
