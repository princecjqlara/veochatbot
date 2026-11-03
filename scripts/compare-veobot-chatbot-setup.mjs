// Verify original settings against the destination. Empty tables never pass as
// a completed migration. This command reads both artifacts and DB without edits.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {assertProjectCredentials,VEO_TARGET_PROJECT,sqlIdentifier as ident} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
import {migrationMetadataSql,migrationDataPlan,preservationColumnGaps,verifyMigrationBackup,isChatbotPreservationTable} from './lib/migration-data.mjs';
const dir=path.resolve('.vercel/database-migration');
const explicit=process.argv.find(arg=>arg.startsWith('--manifest='))?.slice(11);
const latest=explicit?{manifest:explicit}:JSON.parse(fs.readFileSync(path.join(dir,fs.existsSync(path.join(dir,'latest-account-backup.json'))?'latest-account-backup.json':'latest-chatbot-backup.json'),'utf8'));
await verifyMigrationBackup(latest.manifest);
const source=JSON.parse(fs.readFileSync(latest.manifest,'utf8'));
const endpoint=assertProjectCredentials(process.env,VEO_TARGET_PROJECT);
const db=new pg.Client({...await migrationConnectionOptions(endpoint.connectionString),connectionTimeoutMillis:30000,statement_timeout:60000,query_timeout:60000});db.on('error',()=>{});
const report={source_backup_run_id:source.run_id,started_at:new Date().toISOString(),target_project:VEO_TARGET_PROJECT,passed:false,full_chatbot_setup_verified:false,tables:[],source_database_writes:0,target_database_writes:0,openrouter_calls:0,customer_messages_sent:0};
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await db.query("SET LOCAL timezone='UTC';SET LOCAL extra_float_digits=3");
 const metadata=(await db.query(migrationMetadataSql)).rows;
 const plan=migrationDataPlan(source.columns,source.foreign_keys);
 const names=source.tables.filter(t=>isChatbotPreservationTable(t.name)).map(t=>t.name);
 report.column_gaps=preservationColumnGaps(source.columns,metadata,names);
 if(report.column_gaps.missing.length||report.column_gaps.changed.length)throw Error('The destination cannot preserve every original chatbot column');
 const parameters=[source.pages.map(p=>p.id),source.account_id];
 for(const item of source.tables.filter(t=>names.includes(t.name))){
  const fields=item.columns.map(c=>'t.'+ident(c)).join(','),order=item.primary_key.map(c=>'t.'+ident(c)).join(',');
  const hash=createHash('sha256');let rows=0;
  await db.query(`DECLARE veobot_compare_cursor NO SCROLL CURSOR FOR SELECT to_jsonb(original)::text AS row FROM
   (SELECT ${fields} FROM public.${ident(item.name)} t WHERE $1::uuid[] IS NOT NULL AND $2::uuid IS NOT NULL AND (${plan.filter(item.name)}) ORDER BY ${order}) original`,parameters);
  for(;;){const batch=await db.query('FETCH FORWARD 2000 FROM veobot_compare_cursor');if(!batch.rows.length)break;for(const record of batch.rows){hash.update(record.row+'\n');rows++;}}
  await db.query('CLOSE veobot_compare_cursor');const actualHash=hash.digest('hex');
  report.tables.push({table:item.name,source_rows:item.rows,destination_rows:rows,source_sha256:item.sha256,destination_sha256:actualHash,identical:rows===item.rows&&actualHash===item.sha256});
 }
 await db.query('ROLLBACK');report.passed=report.tables.length===names.length&&report.tables.every(t=>t.identical);report.full_chatbot_setup_verified=report.passed;
 if(!report.passed)report.error='Original chatbot data has not been fully copied and verified in the destination';
}catch(error){await db.query('ROLLBACK').catch(()=>{});report.error=String(error.message).replace(/postgres(?:ql)?:\/\/\S+|eyJ[\w.-]+|EA[\w-]{25,}/g,'[redacted]');report.code=error.code||null;}
finally{await db.end().catch(()=>{});report.completed_at=new Date().toISOString();fs.writeFileSync(path.join(dir,'chatbot-preservation-comparison.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,full_chatbot_setup_verified:report.full_chatbot_setup_verified,tables_checked:report.tables.length,different_tables:report.tables.filter(t=>!t.identical),error:report.error}));if(!report.passed)process.exitCode=1;}
