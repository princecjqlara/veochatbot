import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {createClient} from '@supabase/supabase-js';
import {assertProjectCredentials,VEO_TARGET_PROJECT} from './lib/database-migration-safety.mjs';
assertProjectCredentials(process.env,VEO_TARGET_PROJECT);
const dir=path.resolve('.vercel/database-migration'),latest=JSON.parse(fs.readFileSync(path.join(dir,'latest-account-backup.json'),'utf8'));
const sourceDir=path.join(path.dirname(path.resolve(latest.manifest)),'storage'),source=JSON.parse(fs.readFileSync(path.join(sourceDir,'manifest.json'),'utf8'));
if(!source.passed||source.source_backup_run_id!==latest.run_id||source.objects.length!==source.expected_objects)throw Error('A complete verified storage snapshot is required');
const out=path.join(dir,'storage-import.json'),prior=fs.existsSync(out)?JSON.parse(fs.readFileSync(out,'utf8')):null;
const report={started_at:new Date().toISOString(),target_project:VEO_TARGET_PROJECT,source_backup_run_id:latest.run_id,passed:false,objects:[],source_database_writes:0,openrouter_calls:0,customer_messages_sent:0};
const flush=()=>{fs.writeFileSync(out+'.tmp',JSON.stringify(report,null,2));fs.renameSync(out+'.tmp',out);};
const api=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(u,o)=>{const response=await fetch(u,{...o,signal:AbortSignal.timeout(45000)});report.last_http_status=response.status;report.last_storage_endpoint=new URL(String(u)).pathname;return response;}}});
const hash=b=>createHash('sha256').update(b).digest('hex');
try{
 for(const bucket of source.buckets){
  report.current_bucket=bucket.id;flush();
  let existing=await api.storage.getBucket(bucket.id);
  if(existing.error){if(!/not found|does not exist/i.test(existing.error.message||'')&&String(existing.error.statusCode||existing.error.status)!=='404')throw existing.error;const created=await api.storage.createBucket(bucket.id,{public:bucket.public,fileSizeLimit:bucket.file_size_limit?Number(bucket.file_size_limit):undefined,allowedMimeTypes:bucket.allowed_mime_types||undefined});if(created.error)throw created.error;existing=await api.storage.getBucket(bucket.id);}
  if(existing.error||existing.data?.public!==bucket.public)throw Error('Destination bucket privacy differs: '+bucket.id);
 }
 for(const object of source.objects){
  if(object.file!==object.sha256+'.bin'||!/^[a-f0-9]{64}$/.test(object.sha256))throw Error('Unexpected source object artifact');
  const bytes=fs.readFileSync(path.join(sourceDir,object.file));if(bytes.length!==object.bytes||hash(bytes)!==object.sha256)throw Error('Source object checksum differs');
  report.current_object={bucket:object.bucket_id,path:object.name};flush();
  const saved=await api.storage.from(object.bucket_id).download(object.name);let replace=false;
  if(saved.data){const existing=Buffer.from(await saved.data.arrayBuffer()),actual=hash(existing);if(actual===object.sha256){report.objects.push({bucket:object.bucket_id,path:object.name,bytes:bytes.length,sha256:actual,identical:true,reused:true});flush();continue;}
   const previous=prior?.target_project===VEO_TARGET_PROJECT&&prior.objects.find(o=>o.bucket===object.bucket_id&&o.path===object.name&&o.sha256===actual);
   if(!previous)throw Error('Destination contains a different, unrecognized object at this path');replace=true;
  }
  // A failed read is not proof of absence. A conditional upload with upsert=false
  // safely asks Storage to create the path and refuses to overwrite any object.
  const uploaded=await api.storage.from(object.bucket_id).upload(object.name,bytes,{upsert:replace,contentType:object.metadata?.mimetype||'application/octet-stream',cacheControl:'3600'});if(uploaded.error)throw uploaded.error;
  const verified=await api.storage.from(object.bucket_id).download(object.name);if(verified.error||!verified.data)throw verified.error||Error('Uploaded object is unavailable');
  const actual=Buffer.from(await verified.data.arrayBuffer());if(actual.length!==bytes.length||hash(actual)!==object.sha256)throw Error('Destination object checksum differs');
  report.objects.push({bucket:object.bucket_id,path:object.name,bytes:bytes.length,sha256:object.sha256,identical:true,replaced_earlier_migration_copy:replace});flush();
 }
 report.passed=report.objects.length===source.expected_objects;delete report.current_object;report.completed_at=new Date().toISOString();flush();console.log(JSON.stringify({passed:report.passed,objects:report.objects.length,bytes:report.objects.reduce((n,o)=>n+o.bytes,0)}));
}catch(error){report.error=String(error.message||error).replace(/eyJ[\w.-]+|EA[\w-]{25,}/g,'[redacted]');report.error_name=error.name;report.completed_at=new Date().toISOString();flush();console.error(JSON.stringify({passed:false,error:report.error,status:report.last_http_status}));process.exitCode=1;}
