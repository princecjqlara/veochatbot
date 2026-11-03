// Consistent, read-only preservation of this account's application data.
// A completed backup does not authorize a production cutover or job replay.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { assertProjectCredentials, LEGACY_SOURCE_PROJECT, VEO_TARGET_PROJECT, sqlIdentifier as ident } from './lib/database-migration-safety.mjs';
import { migrationConnectionOptions } from './lib/migration-retry.mjs';
import { migrationMetadataSql, migrationForeignKeysSql, migrationDataPlan, verifyMigrationClosure, isChatbotPreservationTable } from './lib/migration-data.mjs';

const dir=path.resolve('.vercel/database-migration');
const actor=JSON.parse(fs.readFileSync('.vercel/calendar-fix-actor.json','utf8'));
if(!/^[0-9a-f-]{36}$/.test(actor.user_id)) throw Error('A verified account identity is required');
const endpoint=assertProjectCredentials(process.env,LEGACY_SOURCE_PROJECT);
const runId=randomUUID(), destination=path.join(dir,'backups',runId);
fs.mkdirSync(destination,{recursive:true});
const kind=process.argv.includes('--chatbot-only')?'chatbot':'account',statusName=kind==='chatbot'?'chatbot-backup-status.json':'account-backup-status.json';
const report={run_id:runId,started_at:new Date().toISOString(),source_project:LEGACY_SOURCE_PROJECT,target_project:VEO_TARGET_PROJECT,
 backup_kind:kind,scope_kind:'current_account_membership_preservation',account_id:actor.user_id,passed:false,source_backup_completed:false,
 source_database_writes:0,openrouter_calls:0,customer_messages_sent:0,production_cutover_completed:false,tables:[]};
const flush=()=>{const file=path.join(destination,'manifest.json'),tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(report,null,2));fs.renameSync(tmp,file);
 const status=path.join(dir,statusName);fs.writeFileSync(status+'.tmp',JSON.stringify({run_id:runId,status:report.source_backup_completed||report.chatbot_backup_completed?'complete':report.error?'failed':'running',manifest:path.relative(process.cwd(),file),tables_completed:report.tables.length,current_table:report.current_table,rows_in_current_table:report.rows_in_current_table,error:report.error,updated_at:new Date().toISOString()},null,2));fs.renameSync(status+'.tmp',status);};
const db=new pg.Client({...await migrationConnectionOptions(endpoint.connectionString),connectionTimeoutMillis:30000,query_timeout:120000,statement_timeout:120000});db.on('error',()=>{});
let output,gzip,streamDone;
flush();
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await db.query("SET LOCAL timezone='UTC';SET LOCAL extra_float_digits=3;SET LOCAL idle_in_transaction_session_timeout='300s';SET LOCAL lock_timeout='5s'");
 report.snapshot=(await db.query('SELECT transaction_timestamp() AS at,txid_current_snapshot()::text AS identity')).rows[0];
 report.pages=(await db.query(`SELECT p.id,p.fb_page_id,p.name FROM public.pages p WHERE EXISTS(SELECT 1 FROM public.user_pages u WHERE u.page_id=p.id AND u.user_id=$1) ORDER BY p.id`,[actor.user_id])).rows;
 if(!report.pages.length)throw Error('This account has no source Pages');
 const parameters=[report.pages.map(p=>p.id),actor.user_id];
 report.columns=(await db.query(migrationMetadataSql)).rows;
 report.foreign_keys=(await db.query(migrationForeignKeysSql)).rows;
 const plan=migrationDataPlan(report.columns,report.foreign_keys,{focus:kind==='chatbot'?'chatbot':undefined});
 report.excluded_tables=plan.excluded;report.derived_views=plan.views;
 report.current_table='Checking account dependencies';flush();
 plan.cacheUsers((await db.query(`SELECT t.id FROM public.users t WHERE (${plan.filter('users')})`,parameters)).rows.map(r=>r.id));
 // Preserve first, then check every dependency in the same snapshot. A failing
 // dependency check must not prevent the original settings from being saved.
 report.chatbot_shared_knowledge=(await db.query(`SELECT page_id,knowledge_source_page_id FROM chatbot_configs WHERE page_id=ANY($1::uuid[]) AND knowledge_source_page_id IS NOT NULL`,[parameters[0]])).rows;
 flush();
 const selected=plan.tables.filter(t=>kind==='account'||isChatbotPreservationTable(t.name)).sort((a,b)=>
  Number(isChatbotPreservationTable(b.name))-Number(isChatbotPreservationTable(a.name))||a.name.localeCompare(b.name));
 for(const item of selected){
  const filename=item.name+'.jsonl.gz',partial=path.join(destination,filename+'.partial');
  report.current_table=item.name;report.rows_in_current_table=0;flush();
  gzip=createGzip({level:6});output=fs.createWriteStream(partial,{flags:'wx'});streamDone=pipeline(gzip,output);streamDone.catch(()=>{});
  const hash=createHash('sha256');let count=0,bytes=0;
  const order=item.primary_key.map(k=>'t.'+ident(k)).join(',');
  await db.query(`DECLARE veobot_backup_cursor NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS row FROM public.${ident(item.name)} t WHERE $1::uuid[] IS NOT NULL AND $2::uuid IS NOT NULL AND (${item.where}) ORDER BY ${order}`,parameters);
  for(;;){
   const result=await db.query('FETCH FORWARD 10000 FROM veobot_backup_cursor');if(!result.rows.length)break;
   for(const record of result.rows){const line=record.row+'\n';hash.update(line);bytes+=Buffer.byteLength(line);if(!gzip.write(line))await once(gzip,'drain');count++;}
   report.rows_in_current_table=count;flush();
  }
  await db.query('CLOSE veobot_backup_cursor');gzip.end();await streamDone;
  fs.renameSync(partial,path.join(destination,filename));
  report.tables.push({name:item.name,file:filename,rows:count,uncompressed_bytes:bytes,sha256:hash.digest('hex'),primary_key:item.primary_key,columns:item.columns.map(c=>c.column_name)});
  flush();
 }
 const selectedNames=new Set(selected.map(t=>t.name));
 report.dependency_gaps=await verifyMigrationClosure(db,plan,report.foreign_keys.filter(fk=>selectedNames.has(fk.child)),parameters,fk=>{report.current_table='Checking dependencies: '+fk.child;flush();});
 await db.query('ROLLBACK');
 delete report.current_table;delete report.rows_in_current_table;
 report.source_backup_completed=kind==='account';report.chatbot_backup_completed=kind==='chatbot';report.passed=true;report.completed_at=new Date().toISOString();
 report.data_dependencies_closed=report.dependency_gaps.length===0;
 report.ready_for_import=false; // Scope and destination compatibility are separate gates.
 report.requires_complete_account_backup=kind==='chatbot';
 report.import_scope_approval_pending=true;
 flush();
 const latestFile=path.join(dir,kind==='chatbot'?'latest-chatbot-backup.json':'latest-account-backup.json');
 fs.writeFileSync(latestFile+'.tmp',JSON.stringify({run_id:runId,backup_kind:kind,manifest:path.relative(process.cwd(),path.join(destination,'manifest.json')),completed_at:report.completed_at,passed:true,pages:report.pages.length,tables:report.tables.length},null,2));fs.renameSync(latestFile+'.tmp',latestFile);
 console.log(JSON.stringify({passed:true,run_id:runId,pages:report.pages.length,tables:report.tables.length,rows:report.tables.reduce((n,t)=>n+t.rows,0),dependency_gaps:report.dependency_gaps.length,manifest:path.relative(process.cwd(),path.join(destination,'manifest.json'))}));
}catch(error){gzip?.destroy();output?.destroy();await streamDone?.catch(()=>{});await db.query('ROLLBACK').catch(()=>{});
 report.error=String(error.message).replace(/postgres(?:ql)?:\/\/\S+|eyJ[\w.-]+|EA[\w-]{25,}/g,'[redacted]');report.code=error.code||null;report.completed_at=new Date().toISOString();flush();console.error(JSON.stringify({passed:false,error:report.error,code:report.code}));process.exitCode=1;
}finally{await db.end().catch(()=>{});}
