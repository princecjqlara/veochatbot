// The destination remains offline throughout staging. Each verified table and
// its checkpoint commit together, allowing safe retries of this exact snapshot.
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {assertProjectCredentials,VEO_TARGET_PROJECT,LEGACY_SOURCE_PROJECT,sqlIdentifier as ident,digest} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
import {verifyMigrationBackup,migrationMetadataSql,migrationForeignKeysSql} from './lib/migration-data.mjs';
import {importColumnPlan,importDependencyOrder,importMigrationTableCopy,verifyImportedTable,legacyContactNamePreservationSql,resetImportedIdentitySequences} from './lib/migration-import.mjs';
if(process.argv.find(a=>a.startsWith('--target-project='))?.slice(17)!==VEO_TARGET_PROJECT)throw Error('Explicit intended destination is required');
const dir=path.resolve('.vercel/database-migration'),latest=JSON.parse(fs.readFileSync(path.join(dir,'latest-account-backup.json'),'utf8'));
const sourceFile=path.resolve(latest.manifest),source=JSON.parse(fs.readFileSync(sourceFile,'utf8')),verification=await verifyMigrationBackup(sourceFile);
const scope=JSON.parse(fs.readFileSync(path.join(dir,'account-import-scope.json'),'utf8')),scopeHash=digest(JSON.stringify(scope));
if(verification.backup_kind!=='account'||verification.dependency_gaps.length||scope.source_project!==LEGACY_SOURCE_PROJECT||scope.target_project!==VEO_TARGET_PROJECT||scope.account_id!==source.account_id||!scope.preserve_all_current_account_pages||JSON.stringify([...scope.page_ids].sort())!==JSON.stringify(source.pages.map(p=>p.id).sort()))throw Error('A verified complete snapshot and matching account scope are required');
const endpoint=assertProjectCredentials(process.env,VEO_TARGET_PROJECT),db=new pg.Client({...await migrationConnectionOptions(endpoint.connectionString),application_name:'veobot-checkpointed-import',connectionTimeoutMillis:30000,query_timeout:180000,statement_timeout:180000,keepAlive:true,keepAliveInitialDelayMillis:10000});db.on('error',()=>{});
const report={run_id:randomUUID(),source_backup_run_id:source.run_id,scope_sha256:scopeHash,source_snapshot:source.snapshot,started_at:new Date().toISOString(),target_project:VEO_TARGET_PROJECT,passed:false,applied:false,source_database_writes:0,openrouter_calls:0,customer_messages_sent:0,production_cutover_completed:false,tables:[]};
const deferLarge=process.argv.includes('--defer-large-history');
const flush=()=>{const f=path.join(dir,'account-import-checkpoints.json');fs.writeFileSync(f+'.tmp',JSON.stringify(report,null,2));fs.renameSync(f+'.tmp',f);};
const begin=async()=>{await db.query('BEGIN');await db.query("SET LOCAL timezone='UTC';SET LOCAL extra_float_digits=3;SET LOCAL lock_timeout='5s';SET LOCAL idle_in_transaction_session_timeout='300s'");if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('veobot_account_import')) AS locked")).rows[0].locked)throw Error('Another account import transaction is running');};
const checkpoint=async name=>(await db.query('SELECT receipt,scope_sha256 FROM app_private.veobot_import_checkpoints WHERE source_backup_run_id=$1 AND table_name=$2',[source.run_id,name])).rows[0];
try{
 await db.connect();report.backend_pid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;flush();await begin();
 await db.query(`CREATE TABLE IF NOT EXISTS app_private.veobot_import_checkpoints(source_backup_run_id uuid NOT NULL,table_name text NOT NULL,scope_sha256 text NOT NULL,receipt jsonb NOT NULL,committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(source_backup_run_id,table_name));
  CREATE TABLE IF NOT EXISTS app_private.veobot_import_jobs(source_backup_run_id uuid PRIMARY KEY,scope_sha256 text NOT NULL,paused_cron_jobs jsonb NOT NULL DEFAULT '[]',status text NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  REVOKE ALL ON app_private.veobot_import_checkpoints,app_private.veobot_import_jobs FROM PUBLIC,anon,authenticated;`);
 let metadata=(await db.query(migrationMetadataSql)).rows;
 const tables=source.tables.filter(t=>metadata.some(c=>c.table_name===t.name));report.empty_unsupported_tables=source.tables.filter(t=>!tables.some(v=>v.name===t.name)).map(t=>({table:t.name,rows:t.rows}));
 report.compatibility_columns=importColumnPlan(source.columns,metadata,source.tables);
 const foreignKeys=(await db.query(migrationForeignKeysSql)).rows;
 report.deferred_tables=deferLarge?tables.filter(t=>['campaign_recipients','outbound_message_events'].includes(t.name)).map(t=>({table:t.name,rows:t.rows})):[];
 const ordered=importDependencyOrder(tables.filter(t=>!report.deferred_tables.some(d=>d.table===t.name)),foreignKeys);
 for(const item of tables){const saved=await checkpoint(item.name),n=(await db.query(`SELECT count(*)::text AS n FROM public.${ident(item.name)}`)).rows[0].n;
  if(saved&&(saved.scope_sha256!==scopeHash||saved.receipt.source_sha256!==item.sha256))throw Error('Checkpoint belongs to another source scope: '+item.name);
  if(n!=='0'&&!saved&&item.name!=='ad_tracking_settings')throw Error('Destination has records without a verified import checkpoint: '+item.name);
 }
 for(const column of report.compatibility_columns)await db.query(column.sql);
 await db.query(legacyContactNamePreservationSql);
 const oldJob=(await db.query('SELECT * FROM app_private.veobot_import_jobs WHERE source_backup_run_id=$1',[source.run_id])).rows[0];
 if(oldJob&&oldJob.scope_sha256!==scopeHash)throw Error('Import job scope changed');
 if(!oldJob){const jobs=(await db.query('SELECT jobid FROM cron.job WHERE active AND username=current_user')).rows;for(const job of jobs)await db.query('SELECT cron.alter_job($1::bigint,active:=false)',[job.jobid]);await db.query("INSERT INTO app_private.veobot_import_jobs(source_backup_run_id,scope_sha256,paused_cron_jobs,status) VALUES($1,$2,$3::jsonb,'staging')",[source.run_id,scopeHash,JSON.stringify(jobs)]);}
 await db.query('COMMIT');metadata=(await db.query(migrationMetadataSql)).rows;
 for(const item of ordered){
  report.current_table=item.name;report.current_table_rows=0;report.stage='staging';flush();await begin();
  const saved=await checkpoint(item.name);
  if(saved){
   if(saved.scope_sha256!==scopeHash||saved.receipt.source_sha256!==item.sha256)throw Error('Changed checkpoint: '+item.name);
   report.stage='rechecking_checkpoint';flush();await verifyImportedTable(db,item,saved.receipt,n=>{report.current_table_rows=n;flush();});
   await db.query('ROLLBACK');report.tables.push({...saved.receipt,reused:true});flush();continue;
  }
  const existing=(await db.query(`SELECT count(*)::text AS n FROM public.${ident(item.name)}`)).rows[0].n;
  if(existing!=='0'&&item.name!=='ad_tracking_settings')throw Error('Uncheckpointed destination data appeared: '+item.name);
  const triggers=(await db.query("SELECT t.tgname AS name,t.tgenabled AS state FROM pg_trigger t WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal ORDER BY 1",['public.'+ident(item.name)])).rows;
  await db.query(`ALTER TABLE public.${ident(item.name)} DISABLE TRIGGER USER`);
  if(item.name==='ad_tracking_settings')await db.query('DELETE FROM public.ad_tracking_settings');
  const inserted=await importMigrationTableCopy(db,path.dirname(sourceFile),item,n=>{report.current_table_rows=n;flush();});
  report.stage='verifying_table';flush();await verifyImportedTable(db,item,inserted,n=>{report.current_table_rows=n;flush();});
  await resetImportedIdentitySequences(db,item,metadata);
  for(const trigger of triggers){const action={O:'ENABLE',R:'ENABLE REPLICA',A:'ENABLE ALWAYS',D:'DISABLE'}[trigger.state];if(!action)throw Error('Unexpected trigger state');await db.query(`ALTER TABLE public.${ident(item.name)} ${action} TRIGGER ${ident(trigger.name)}`);}
  await db.query('INSERT INTO app_private.veobot_import_checkpoints(source_backup_run_id,table_name,scope_sha256,receipt) VALUES($1,$2,$3,$4::jsonb)',[source.run_id,item.name,scopeHash,JSON.stringify(inserted)]);await db.query('COMMIT');
  report.tables.push({...inserted,identical:true});flush();
 }
 const complete=report.deferred_tables.length===0;
 await begin();await db.query('UPDATE app_private.veobot_import_jobs SET status=$2,updated_at=clock_timestamp() WHERE source_backup_run_id=$1',[source.run_id,complete?'baseline_verified':'core_verified_storage_pending']);await db.query("NOTIFY pgrst,'reload schema'");await db.query('COMMIT');
 report.passed=true;report.applied=true;report.baseline_complete=complete;report.stage=complete?'baseline_verified_delta_pending':'core_verified_storage_pending';report.rows=report.tables.reduce((n,t)=>n+t.rows,0);delete report.current_table;delete report.current_table_rows;report.completed_at=new Date().toISOString();flush();console.log(JSON.stringify({passed:true,applied:true,baseline_complete:complete,rows:report.rows,tables:report.tables.length,deferred_tables:report.deferred_tables,production_cutover_completed:false}));
}catch(error){report.error=String(error.message).replace(/postgres(?:ql)?:\/\/\S+|eyJ[\w.-]+|EA[\w-]{25,}/g,'[redacted]');report.code=error.code||null;report.completed_at=new Date().toISOString();flush();console.error(JSON.stringify({passed:false,error:report.error,code:report.code}));process.exitCode=1;
 if(/timeout|connection|timed out/i.test(error.message))db.connection?.stream?.destroy();else await Promise.race([db.query('ROLLBACK').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,5000))]);
}finally{await Promise.race([db.end().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,5000))]);db.connection?.stream?.destroy();}
