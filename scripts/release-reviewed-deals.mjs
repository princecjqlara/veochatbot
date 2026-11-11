import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import {assertProjectCredentials,VEO_RECOVERY_PROJECT,schemaMigrationPlan,migrationFingerprintMatches} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
const mode=process.argv[2];assert(['--preflight','--apply','--activate','--enable-supervisor-submissions'].includes(mode),'Choose --preflight, --apply, --activate or --enable-supervisor-submissions');
const owner=fs.readFileSync('src/config/veo-owner.ts','utf8').match(/CJ_OWNER_USER_ID\s*=\s*'([^']+)'/)[1];
const filenames=['202611110008_veo_reviewed_deal_evidence.sql','202611110009_veo_reviewed_delivery_totals.sql','202611110010_veo_deal_review_attribution.sql','202611120001_veo_supervisor_receipt_submission.sql','202611120002_veo_deal_evidence_slots.sql','202611120003_veo_hourly_ads_existing_cron.sql'],plan=schemaMigrationPlan(),migrations=filenames.map(name=>plan.find(m=>m.name===name));
assert(migrations.every(Boolean));const db=new pg.Client({...await migrationConnectionOptions(assertProjectCredentials(process.env,VEO_RECOVERY_PROJECT).connectionString),connectionTimeoutMillis:30000,query_timeout:60000});db.on('error',()=>{});
const directory='.vercel/deal-review-release';fs.mkdirSync(directory,{recursive:true});
async function retained(){return (await db.query(`SELECT (SELECT count(*) FROM users)::int users,(SELECT count(*) FROM veo_accounts)::int accounts,(SELECT count(*) FROM veo_teams)::int teams,(SELECT count(*) FROM user_pages)::int page_grants,(SELECT count(*) FROM contacts)::int contacts,(SELECT count(*) FROM veo_orders)::int orders,(SELECT count(*) FROM veo_payments)::int payments,(SELECT count(*) FROM veo_closed_deals)::int closed_deals,(SELECT count(*) FROM chatbot_knowledge_documents)::int knowledge,(SELECT count(*) FROM chatbot_drive_files)::int files,(SELECT count(*) FROM pages)::int pages`)).rows[0];}
try{
 await db.connect();await db.query('BEGIN');await db.query("SET LOCAL jit=off;SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='45s'");await db.query("SELECT pg_advisory_xact_lock(hashtextextended('veo-reviewed-deals-release',0))");
 const tenant=(await db.query('SELECT id,launch_at FROM veo_tenants WHERE owner_id=$1',[owner])).rows[0];assert(tenant?.launch_at,'Owner workspace must already be launched');
 const installed=(await db.query('SELECT filename,sha256,project_ref FROM app_private.veobot_project_migrations')).rows;
 for(const previous of plan.filter(m=>m.name<filenames[0])){assert(migrationFingerprintMatches(installed.find(r=>r.filename===previous.name),previous,VEO_RECOVERY_PROJECT),'Missing or changed baseline: '+previous.name);}
 const before=await retained();
 if(mode==='--enable-supervisor-submissions'){
  for(const migration of migrations)assert(migrationFingerprintMatches(installed.find(r=>r.filename===migration.name),migration,VEO_RECOVERY_PROJECT),'Apply reviewed deal migrations first');
  const botUrl=new URL('/api/veo/workspace?tenant_id='+tenant.id,process.env.VEO_JAUCIAN_URL);assert.equal(botUrl.protocol,'https:');assert(process.env.VEO_JAUCIAN_SECRET,'Bot authentication is required');
  const bot=await fetch(botUrl,{headers:{Authorization:'Bearer '+process.env.VEO_JAUCIAN_SECRET},signal:AbortSignal.timeout(30000)}),capabilities=await bot.json();assert(bot.ok&&capabilities.tenant_id===tenant.id&&capabilities.receipt_submissions?.supervisor_direct_submission===true&&capabilities.receipt_submissions?.staff_review_required===true,'Deploy the compatible bot before enabling supervisor submissions');
  const settings=(await db.query('SELECT * FROM veo_deal_review_settings WHERE tenant_id=$1 FOR UPDATE',[tenant.id])).rows[0];assert(settings?.enabled,'Reviewed deals must already be enabled');
  if(!settings.supervisor_submissions_enabled){
   await db.query('UPDATE veo_deal_review_settings SET supervisor_submissions_enabled=true,updated_at=clock_timestamp() WHERE tenant_id=$1',[tenant.id]);
   await db.query("INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES($1,$2,'supervisor_receipt_submission_enabled',$1,$3,'User requested supervisor receipts send without review; staff receipts still require independent supervisor approval')",[tenant.id,owner,JSON.stringify({supervisor_submissions_enabled:true,staff_review_required:true})]);
  }
 }else if(mode==='--activate'){
  for(const migration of migrations)assert(migrationFingerprintMatches(installed.find(r=>r.filename===migration.name),migration,VEO_RECOVERY_PROJECT),'Apply reviewed deal migrations first');
  const previous=(await db.query('SELECT * FROM veo_deal_review_settings WHERE tenant_id=$1',[tenant.id])).rows[0];
  if(!previous?.enabled){
   const snapshot={at:new Date().toISOString(),retained:before,settings:previous||null,intakePolicy:(await db.query('SELECT * FROM veo_intake_auto_policy WHERE tenant_id=$1',[tenant.id])).rows};fs.writeFileSync(directory+'/before-activation.private.json',JSON.stringify(snapshot,null,2),{flag:'wx'});
   await db.query('INSERT INTO veo_deal_review_settings(tenant_id,enabled) VALUES($1,true) ON CONFLICT(tenant_id) DO UPDATE SET enabled=true,updated_at=clock_timestamp()',[tenant.id]);
   const cutoff='2026-11-11T15:13:50Z';await db.query('UPDATE veo_intake_auto_policy SET enabled_at=$2 WHERE tenant_id=$1',[tenant.id,cutoff]);
   // Retain history and ownership; retire only unaccepted pre-cutoff offers.
   await db.query("UPDATE veo_client_offers o SET status='cancelled',ended_at=clock_timestamp() FROM contacts c WHERE c.id=o.contact_id AND o.tenant_id=$1 AND o.status='pending' AND coalesce(c.first_interaction_at,c.created_at)<$2 AND NOT EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=c.id AND user_id IS NOT NULL)",[tenant.id,cutoff]);
   await db.query("UPDATE veo_intake_dispatch d SET status='cancelled',last_error='Inquiry predates the current new-client cutoff' FROM contacts c WHERE c.id=d.contact_id AND d.tenant_id=$1 AND d.status IN('waiting','offered') AND coalesce(c.first_interaction_at,c.created_at)<$2",[tenant.id,cutoff]);
   await db.query("INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES($1,$2,'reviewed_deals_enabled',$1,$3,'Three evidence photos and independent supervisor approval before ledger and Telegram delivery')",[tenant.id,owner,JSON.stringify({enabled:true,new_client_cutoff:cutoff,tip_commission_included:false})]);
  }
 }else{
  for(const migration of migrations){const filename=migration.name,current=installed.find(r=>r.filename===filename);
  if(current)assert(migrationFingerprintMatches(current,migration,VEO_RECOVERY_PROJECT),'Installed migration fingerprint differs');
  else{
   await db.query(migration.sql);
   await db.query('INSERT INTO app_private.veobot_project_migrations(filename,sha256,project_ref) VALUES($1,$2,$3)',[filename,migration.sha256,VEO_RECOVERY_PROJECT]);
   if((await db.query("SELECT to_regclass('app_private.schema_migrations') IS NOT NULL present")).rows[0].present)await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT(version) DO NOTHING',[filename.split('_')[0],filename]);
   if((await db.query("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL present")).rows[0].present)await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING',[filename.split('_')[0],filename.replace('.sql',''),[migration.sql]]);
  }}
 }
 const after=await retained();assert.deepEqual(after,before,'Existing accounts and business data must be preserved');
 for(const fn of ['veo_submit_deal_review(uuid,jsonb,uuid[])','veo_review_deal(uuid,uuid,text,boolean,boolean,boolean,text)'])assert.equal((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') exposed",[fn])).rows[0].exposed,false);
 const result={at:new Date().toISOString(),mode,migrations:filenames,passed:true,existingDataPreserved:true,retained:after,artificialSalesCreated:0,telegramMessagesSent:0};
 await db.query(mode==='--preflight'?'ROLLBACK':'COMMIT');fs.writeFileSync(directory+'/'+mode.slice(2)+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({passed:false,error:e.message}));process.exitCode=1;}finally{await db.end();}
