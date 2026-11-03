import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import pg from 'pg';
import {assertProjectCredentials,VEO_TARGET_PROJECT,LEGACY_SOURCE_PROJECT,sqlIdentifier as ident,digest} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
import {verifyMigrationBackup,migrationMetadataSql,migrationForeignKeysSql} from './lib/migration-data.mjs';
import {importColumnPlan,importDependencyOrder,importMigrationTable,verifyImportedTable,legacyContactNamePreservationSql,preserveLegacyContactNames} from './lib/migration-import.mjs';
const mode=process.argv.includes('--apply')?'apply':process.argv.includes('--preflight')?'preflight':process.argv.includes('--plan')?'plan':null;
if(!mode||['--apply','--preflight','--plan'].filter(a=>process.argv.includes(a)).length!==1)throw Error('Choose exactly one import mode');
const requested=process.argv.find(a=>a.startsWith('--target-project='))?.slice(17);if(requested!==VEO_TARGET_PROJECT)throw Error('The intended destination must be named explicitly');
const dir=path.resolve('.vercel/database-migration'),latest=JSON.parse(fs.readFileSync(path.join(dir,'latest-account-backup.json'),'utf8'));
const manifestFile=path.resolve(latest.manifest),source=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
const verification=await verifyMigrationBackup(manifestFile);
if(verification.backup_kind!=='account'||verification.dependency_gaps.length)throw Error('A complete, dependency-closed account backup is required');
const scope=JSON.parse(fs.readFileSync(path.join(dir,'account-import-scope.json'),'utf8'));
if(scope.source_project!==LEGACY_SOURCE_PROJECT||scope.target_project!==VEO_TARGET_PROJECT||scope.account_id!==source.account_id||!scope.preserve_all_current_account_pages||JSON.stringify([...scope.page_ids].sort())!==JSON.stringify(source.pages.map(p=>p.id).sort()))throw Error('Preserved account Page scope does not match the snapshot');
const endpoint=assertProjectCredentials(process.env,VEO_TARGET_PROJECT),db=new pg.Client({...await migrationConnectionOptions(endpoint.connectionString),application_name:'veobot-preserved-account-import',connectionTimeoutMillis:30000,query_timeout:180000,statement_timeout:180000});db.on('error',()=>{});
const report={run_id:randomUUID(),source_backup_run_id:source.run_id,source_snapshot:source.snapshot,scope_sha256:digest(JSON.stringify(scope)),started_at:new Date().toISOString(),mode,target_project:VEO_TARGET_PROJECT,passed:false,applied:false,source_database_writes:0,openrouter_calls:0,customer_messages_sent:0,production_cutover_completed:false,imported:[],verified:[]};
const flush=()=>{const file=path.join(dir,'account-import-'+mode+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(report,null,2));fs.renameSync(file+'.tmp',file);};
try{
 await db.connect();await db.query(mode==='plan'?'BEGIN READ ONLY':'BEGIN');await db.query("SET LOCAL timezone='UTC';SET LOCAL extra_float_digits=3;SET LOCAL lock_timeout='5s';SET LOCAL idle_in_transaction_session_timeout='300s'");
 report.backend_pid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;flush();
 if(mode!=='plan'&&!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('veobot_account_import')) AS locked")).rows[0].locked)throw Error('Another account importer is running');
 const metadata=(await db.query(migrationMetadataSql)).rows,foreignKeys=(await db.query(migrationForeignKeysSql)).rows;
 report.compatibility_columns=importColumnPlan(source.columns,metadata,source.tables);
 const tables=source.tables.filter(t=>metadata.some(c=>c.table_name===t.name));report.empty_unsupported_tables=source.tables.filter(t=>!tables.some(v=>v.name===t.name)).map(t=>({table:t.name,rows:t.rows}));
 const ordered=importDependencyOrder(tables,foreignKeys);report.table_order=ordered.map(t=>t.name);report.source_rows=source.tables.reduce((n,t)=>n+t.rows,0);
 for(const item of tables){
  const existing=(await db.query(`SELECT count(*)::text AS n FROM public.${ident(item.name)}`)).rows[0].n;
  if(existing!=='0'&&item.name!=='ad_tracking_settings')throw Error('Destination contains existing customer records: '+item.name);
 }
 if(mode==='plan'){report.passed=true;await db.query('ROLLBACK');}
 else{
  for(const column of report.compatibility_columns)await db.query(column.sql);
  await db.query(legacyContactNamePreservationSql);
  const triggers=(await db.query("SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS state FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY 1,2",[tables.map(t=>t.name)])).rows;
  report.preserved_trigger_states=triggers;
  for(const item of tables)await db.query(`ALTER TABLE public.${ident(item.name)} DISABLE TRIGGER USER`);
  // Only the schema-created singleton can precede this otherwise empty import.
  report.previous_ad_tracking_setting=(await db.query('SELECT to_jsonb(t) AS row FROM public.ad_tracking_settings t')).rows;
  await db.query('DELETE FROM public.ad_tracking_settings');
  for(const item of ordered){
   report.current_table=item.name;report.stage='importing';flush();
   const result=await importMigrationTable(db,path.dirname(manifestFile),item,n=>{report.current_table_rows=n;flush();},item.name==='contacts'?json=>preserveLegacyContactNames(db,json):undefined);report.imported.push(result);flush();
  }
  for(const item of ordered){
   report.current_table=item.name;report.stage='verifying';flush();
   report.verified.push(await verifyImportedTable(db,item,report.imported.find(t=>t.table===item.name),n=>{report.current_table_rows=n;flush();}));flush();
  }
  for(const trigger of triggers){const action={O:'ENABLE',R:'ENABLE REPLICA',A:'ENABLE ALWAYS',D:'DISABLE'}[trigger.state];if(!action)throw Error('Unrecognized original trigger state');await db.query(`ALTER TABLE public.${ident(trigger.table_name)} ${action} TRIGGER ${ident(trigger.name)}`);}
  await db.query(`CREATE TABLE IF NOT EXISTS app_private.veobot_account_imports(run_id uuid PRIMARY KEY,source_backup_run_id uuid NOT NULL,scope_sha256 text NOT NULL,receipt jsonb NOT NULL,committed_at timestamptz NOT NULL DEFAULT clock_timestamp());REVOKE ALL ON app_private.veobot_account_imports FROM PUBLIC,anon,authenticated`);
  report.stage='verified';delete report.current_table;delete report.current_table_rows;
  await db.query('INSERT INTO app_private.veobot_account_imports(run_id,source_backup_run_id,scope_sha256,receipt) VALUES($1,$2,$3,$4::jsonb)',[report.run_id,source.run_id,report.scope_sha256,JSON.stringify(report)]);
  await db.query("NOTIFY pgrst,'reload schema'");await db.query(mode==='apply'?'COMMIT':'ROLLBACK');report.applied=mode==='apply';report.passed=true;
 }
 report.completed_at=new Date().toISOString();flush();console.log(JSON.stringify({passed:report.passed,applied:report.applied,run_id:report.run_id,tables:report.table_order.length,rows:report.source_rows,compatibility_columns:report.compatibility_columns.length}));
}catch(error){report.error=String(error.message).replace(/postgres(?:ql)?:\/\/\S+|eyJ[\w.-]+|EA[\w-]{25,}/g,'[redacted]');report.code=error.code||null;report.completed_at=new Date().toISOString();flush();console.error(JSON.stringify({passed:false,error:report.error,code:report.code}));process.exitCode=1;
 if(/timeout|timed out|connection/i.test(error.message)||['08006','ECONNRESET','EPIPE'].includes(error.code))db.connection?.stream?.destroy();
 else await Promise.race([db.query('ROLLBACK').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,5000))]);
}
finally{await Promise.race([db.end().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,5000))]);db.connection?.stream?.destroy();}
