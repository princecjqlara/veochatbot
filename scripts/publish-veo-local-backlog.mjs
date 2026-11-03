import fs from 'node:fs';import path from 'node:path';import {gunzipSync} from 'node:zlib';import {createRequire} from 'node:module';import {build} from 'esbuild';import pg from 'pg';
import {assertProjectCredentials,VEO_TARGET_PROJECT,digest} from './lib/database-migration-safety.mjs';
import {localPublicationRow,publishLocalBatch} from './lib/veo-local-publication.mjs';
const apply=process.argv.includes('--apply');if(!apply&&!process.argv.includes('--preflight'))throw Error('Choose --apply or --preflight');
const endpoint=assertProjectCredentials(process.env,VEO_TARGET_PROJECT),dir=path.resolve('.vercel/veo-backlog'),root=path.resolve('..');
const prepared=JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8'));if(prepared.status!=='prepared_saved_sources'||prepared.errors.length)throw Error('Complete the verified local analysis before publication');
const text=fs.readFileSync(path.join(dir,'prepared-manifest.jsonl'),'utf8'),manifestHash=digest(text),records=text.split('\n').filter(Boolean).map(JSON.parse);
const approved=new Set(JSON.parse(fs.readFileSync('src/config/veo-pages.json','utf8')).map(p=>p.facebook_page_id).filter(Boolean));
const identities=JSON.parse(fs.readFileSync(path.join(dir,'contact-identities.json'),'utf8'));
const bundle=path.join(dir,'publish-runtime.cjs');await build({stdin:{contents:"export * from './src/lib/contact-backlog-analysis';export * from './src/lib/contact-names';",resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const {verifyBacklogArtifact,normalizeContactName}=createRequire(import.meta.url)(bundle);
const rebuild=process.argv.includes('--rebuild'),checkpointFile=path.join(dir,rebuild?'local-publication-rebuild-checkpoint.json':'local-publication-checkpoint.json'),checkpoint=fs.existsSync(checkpointFile)?JSON.parse(fs.readFileSync(checkpointFile,'utf8')):null;
let offset=apply&&checkpoint?.manifest_sha256===manifestHash?checkpoint.next_offset:0;
const report={pid:process.pid,started_at:new Date().toISOString(),target_project:VEO_TARGET_PROJECT,manifest_sha256:manifestHash,applied:apply,status:'publishing',offset,published:0,evidence_messages:0,no_customer_history:0,skipped:0,errors:[],openrouter_calls:0,customer_messages_sent:0};
const reportFile=path.join(dir,apply?(rebuild?'local-publication-rebuild-status.json':'local-publication-status.json'):(rebuild?'local-publication-rebuild-preflight.json':'local-publication-preflight.json'));
const flush=()=>{const tmp=reportFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify({...report,updated_at:new Date().toISOString()},null,2));try{fs.renameSync(tmp,reportFile);}catch(error){if(error.code!=='EPERM'&&error.code!=='EACCES')throw error;fs.copyFileSync(tmp,reportFile);fs.unlinkSync(tmp);}};
const db=new pg.Client({connectionString:endpoint.connectionString,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:25000,query_timeout:120000});db.on('error',()=>{});
const max=Number(process.argv.find(a=>a.startsWith('--limit='))?.slice(8)||(apply?records.length:10));
if(!Number.isSafeInteger(max)||max<1||max>1000000)throw Error('Choose a positive publication limit up to 1000000');
const batchSize=Number(process.argv.find(a=>a.startsWith('--batch-size='))?.slice(13)||75);if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>150)throw Error('Choose a batch size between 1 and 150');
try{
 await db.connect();flush();let considered=0;
 while(offset<records.length&&considered<max){
  const batch=[],end=Math.min(records.length,offset+Math.min(batchSize,max-considered));
  for(let index=offset;index<end;index++){
   const row=records[index];if(!row.verified||!approved.has(row.facebook_page_id))throw Error('A prepared profile is outside approved VeoBot scope');
   const file=path.resolve(row.artifact);if(!file.startsWith(dir+path.sep))throw Error('Artifact escapes scoped local archive');
   const bytes=fs.readFileSync(file);if(digest(bytes)!==row.artifact_sha256)throw Error('A prepared profile changed');const artifact=JSON.parse(gunzipSync(bytes));verifyBacklogArtifact(artifact);
   if(artifact.page_id!==row.page_id||artifact.psid!==row.psid||artifact.facebook_page_id!==row.facebook_page_id||artifact.source_sha256!==row.source_sha256)throw Error('Prepared identity differs from sealed manifest');
   const source=path.resolve(root,artifact.source_archive);if(!source.startsWith(root+path.sep))throw Error('Source escapes local archive');const raw=fs.readFileSync(source);const original=(source.endsWith('.gz')?gunzipSync(raw).toString('utf8'):raw.toString('utf8')).replace(/^\uFEFF/,'');if(digest(original)!==artifact.source_sha256)throw Error('Raw conversation changed');
   const entry=localPublicationRow(artifact,identities[row.page_id+':'+row.psid],normalizeContactName);if(entry)batch.push(entry);else report.no_customer_history++;
  }
  const result=batch.length?await publishLocalBatch(db,batch,apply):{published:0,evidence_messages:0,skipped:0};
  report.published+=result.published;report.evidence_messages+=result.evidence_messages;report.skipped+=result.skipped;considered+=end-offset;offset=end;report.offset=offset;
  if(apply){const tmp=checkpointFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify({manifest_sha256:manifestHash,next_offset:offset,updated_at:new Date().toISOString()}));fs.renameSync(tmp,checkpointFile);}flush();
  if(offset%1500===0)console.log(JSON.stringify({offset,total:records.length,published:report.published,evidence_messages:report.evidence_messages}));
 }
 report.status=offset>=records.length?'complete':'pass_complete';report.finished_at=new Date().toISOString();flush();console.log(JSON.stringify(report));
}catch(e){report.status='retry_needed';report.errors.push({offset,error:e.message,code:e.code});flush();console.error(JSON.stringify({status:report.status,offset,error:e.message,code:e.code}));process.exitCode=1;}finally{await db.end();}
