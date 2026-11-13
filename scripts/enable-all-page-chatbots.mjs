import {createRequire} from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import {assertProjectCredentials,VEO_RECOVERY_PROJECT} from './lib/database-migration-safety.mjs';
import {migrationConnectionOptions} from './lib/migration-retry.mjs';
createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd());
const db=new pg.Client({...await migrationConnectionOptions(assertProjectCredentials(process.env,VEO_RECOVERY_PROJECT).connectionString),connectionTimeoutMillis:15000,query_timeout:25000});
try{
 await db.connect();await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='20s'");
 const pages=(await db.query('SELECT id,name FROM pages ORDER BY name')).rows;
 const configs=(await db.query('SELECT * FROM chatbot_configs ORDER BY page_id FOR UPDATE')).rows;
 const reference=configs.find(c=>c.page_id===c.knowledge_source_page_id&&c.commercial_video_intake_enabled);
 assert(reference?.instructions,'Existing shared commercial chatbot configuration required');
 fs.mkdirSync('.vercel/chatbot-enablement',{recursive:true});
 fs.writeFileSync(`.vercel/chatbot-enablement/before-${Date.now()}.private.json`,JSON.stringify({at:new Date().toISOString(),configs,recovery:(await db.query('SELECT * FROM chatbot_inbound_recovery_pages')).rows},null,2),{flag:'wx'});
 const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='chatbot_configs' ORDER BY ordinal_position")).rows.map(r=>r.column_name).filter(k=>!['id','page_id','created_at','updated_at'].includes(k));
 const quote=k=>'"'+k.replaceAll('"','""')+'"';
 for(const page of pages){
  if(configs.some(c=>c.page_id===page.id))continue;
  await db.query(`INSERT INTO chatbot_configs(page_id,${columns.map(quote).join(',')}) SELECT $1,${columns.map(quote).join(',')} FROM chatbot_configs WHERE page_id=$2`,[page.id,reference.page_id]);
 }
 await db.query('UPDATE chatbot_configs SET enabled=true,trial_mode_enabled=false,trial_contact_id=NULL WHERE page_id=ANY($1::uuid[])',[pages.map(p=>p.id)]);
 await db.query(`INSERT INTO chatbot_inbound_recovery_pages(page_id,enabled,enabled_at) SELECT id,true,clock_timestamp() FROM pages ON CONFLICT(page_id) DO UPDATE SET enabled=true,enabled_at=CASE WHEN chatbot_inbound_recovery_pages.enabled THEN chatbot_inbound_recovery_pages.enabled_at ELSE EXCLUDED.enabled_at END`);
 const result=(await db.query('SELECT p.name,c.enabled,c.trial_mode_enabled,r.enabled recovery_enabled FROM pages p JOIN chatbot_configs c ON c.page_id=p.id JOIN chatbot_inbound_recovery_pages r ON r.page_id=p.id ORDER BY p.name')).rows;
 assert.equal(result.length,pages.length);assert(result.every(p=>p.enabled&&!p.trial_mode_enabled&&p.recovery_enabled));
 await db.query('COMMIT');console.log(JSON.stringify({enabled:result.length,newConfigurations:pages.length-configs.length,pages:result}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}finally{await db.end();}
