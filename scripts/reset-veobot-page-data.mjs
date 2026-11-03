// Target-only reset. Retain exact chatbot setup; never connect to the old DB.
import fs from 'node:fs';import path from 'node:path';import {gzipSync} from 'node:zlib';import pg from 'pg';
import {assertProjectCredentials,VEO_TARGET_PROJECT,sqlIdentifier as ident,digest} from './lib/database-migration-safety.mjs';
import {migrationMetadataSql,migrationForeignKeysSql} from './lib/migration-data.mjs';
import {importDependencyOrder} from './lib/migration-import.mjs';
const apply=process.argv.includes('--apply');
const endpoint=assertProjectCredentials(process.env,VEO_TARGET_PROJECT);
const scope=JSON.parse(fs.readFileSync('src/config/veo-pages.json','utf8'));
const facebookIds=scope.map(p=>p.facebook_page_id).filter(Boolean);
const dir=path.resolve('.vercel/veo-reset');fs.mkdirSync(dir,{recursive:true});
const receiptFile=path.join(dir,'reset-receipt.json');
if(fs.existsSync(receiptFile)&&JSON.parse(fs.readFileSync(receiptFile,'utf8')).applied)throw Error('Reset already applied. Refusing to erase newly collected data.');
const db=new pg.Client({connectionString:endpoint.connectionString,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:25000,query_timeout:120000});db.on('error',()=>{});
const report={target_project:VEO_TARGET_PROJECT,started_at:new Date().toISOString(),applied:false,openrouter_calls:0,source_database_connections:0,retained:[],cleared:[]};
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 await db.query("SET LOCAL timezone='UTC'; SET LOCAL extra_float_digits=3; SET LOCAL lock_timeout='10s'");
 if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('veobot_account_import')) AS locked")).rows[0].locked)throw Error('An import is active');
 const metadata=(await db.query(migrationMetadataSql)).rows;
 const all=(await db.query("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows;
 await db.query('LOCK TABLE '+all.map(t=>'public.'+ident(t.name)).join(',')+' IN ACCESS EXCLUSIVE MODE');
 const pages=(await db.query('SELECT id,fb_page_id,name FROM public.pages WHERE fb_page_id=ANY($1::text[])',[facebookIds])).rows;
 if(pages.length!==facebookIds.length)throw Error('An approved Page is missing from staged setup');
 const ids=pages.map(p=>p.id),params=[ids];
 const filters={users:'true',businesses:'id IN(SELECT business_id FROM pages WHERE id=ANY($1::uuid[]))',business_users:'business_id IN(SELECT business_id FROM pages WHERE id=ANY($1::uuid[]))',pages:'id=ANY($1::uuid[])',user_pages:'page_id=ANY($1::uuid[])',
 chatbot_configs:'page_id=ANY($1::uuid[])',chatbot_knowledge_documents:'page_id=ANY($1::uuid[])',chatbot_knowledge_chunks:'page_id=ANY($1::uuid[])',chatbot_drive_files:'page_id=ANY($1::uuid[])',chatbot_drive_folders:'page_id=ANY($1::uuid[])',chatbot_media_assets:'page_id=ANY($1::uuid[])',
 chatbot_pricing_experiments:'page_id=ANY($1::uuid[])',chatbot_pricing_packages:'experiment_id IN(SELECT id FROM chatbot_pricing_experiments WHERE page_id=ANY($1::uuid[]))',tags:'id IN(SELECT p.tag_id FROM chatbot_pricing_packages p JOIN chatbot_pricing_experiments e ON e.id=p.experiment_id WHERE e.page_id=ANY($1::uuid[]))',welcome_messages:'page_id=ANY($1::uuid[])',workflow_automations:'page_id=ANY($1::uuid[])',ad_tracking_settings:'true'};
 const retained=[];
 for(const [name,filter]of Object.entries(filters)){
  const columns=metadata.filter(c=>c.table_name===name&&!c.generated).map(c=>c.column_name);
  const rows=(await db.query(`SELECT to_jsonb(t)::text AS raw FROM public.${ident(name)} t WHERE $1::uuid[] IS NOT NULL AND (${filter}) ORDER BY to_jsonb(t)::text`,params)).rows.map(r=>r.raw);
  const bytes=Buffer.from(rows.map(r=>r+'\n').join(''));const file=name+'.jsonl.gz';
  fs.writeFileSync(path.join(dir,file),gzipSync(bytes));retained.push({name,columns,rows:rows.length,sha256:digest(bytes),file,raw:rows});report.retained.push({table:name,rows:rows.length,sha256:digest(bytes)});
 }
 const config=retained.find(t=>t.name==='chatbot_configs');
 if(config.rows!==12||retained.find(t=>t.name==='chatbot_knowledge_documents').rows<479)throw Error('Chatbot preservation baseline is incomplete');
 if(config.raw.some(r=>JSON.parse(r).trial_contact_id))throw Error('A config references a customer; review before reset');
 for(const table of all){const n=(await db.query('SELECT count(*)::int AS n FROM public.'+ident(table.name))).rows[0].n;report.cleared.push({table:table.name,previous_rows:n});}
 fs.writeFileSync(path.join(dir,'retained-manifest.json'),JSON.stringify({...report,pages,retained:retained.map(({raw,...t})=>t)},null,2));
 const foreignKeys=(await db.query(migrationForeignKeysSql)).rows;
 const triggers=(await db.query("SELECT c.relname AS table_name,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND NOT t.tgisinternal")).rows;
 for(const t of all)await db.query('ALTER TABLE public.'+ident(t.name)+' DISABLE TRIGGER USER');
 // Every referenced application table is named explicitly. No CASCADE into auth/storage.
 const privateTables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='app_private' AND tablename IN('contact_backlog_publications','veobot_legacy_contact_names','contact_interaction_hourly_stats')")).rows;
 await db.query('TRUNCATE '+[...all.map(t=>'public.'+ident(t.name)),...privateTables.map(t=>'app_private.'+ident(t.tablename))].join(','));
 for(const t of importDependencyOrder(retained,foreignKeys)){
  if(!t.rows)continue;
  const columns=t.columns.map(ident).join(',');
  await db.query(`INSERT INTO public.${ident(t.name)}(${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM jsonb_populate_recordset(NULL::public.${ident(t.name)},$1::jsonb)`,['['+t.raw.join(',')+']']);
  const actual=(await db.query(`SELECT to_jsonb(t)::text AS raw FROM public.${ident(t.name)} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.raw+'\n').join('');
  if(digest(actual)!==t.sha256)throw Error('Restored setup differs: '+t.name);
 }
 // Delivery leases belong to discarded campaigns, not the chatbot configuration.
 await db.query('UPDATE public.pages SET automation_app_id=NULL,campaign_delivery_owner=NULL,campaign_delivery_lease_until=NULL,campaign_delivery_cooldown_until=NULL,campaign_delivery_rate_strikes=0,campaign_delivery_last_rate_limit_at=NULL,messaging_auto_tag_owner=NULL');
 if(!/^\d+$/.test(process.env.FACEBOOK_CLIENT_ID||''))throw Error('Current Facebook app ID is missing');
 await db.query('INSERT INTO app_private.veobot_runtime_policy(singleton,app_id,enforced) VALUES(true,$1,true) ON CONFLICT(singleton) DO UPDATE SET app_id=EXCLUDED.app_id,enforced=true',[process.env.FACEBOOK_CLIENT_ID]);
 await db.query("UPDATE app_private.veobot_import_jobs SET status='superseded_by_veo_page_reset',updated_at=clock_timestamp()");
 for(const t of triggers)await db.query('ALTER TABLE public.'+ident(t.table_name)+' '+({O:'ENABLE',D:'DISABLE',R:'ENABLE REPLICA',A:'ENABLE ALWAYS'}[t.tgenabled])+' TRIGGER '+ident(t.tgname));
 report.known_pages=pages.length;report.pending_page_names=scope.filter(p=>!p.facebook_page_id).map(p=>p.name);report.setup_verified=true;
 await db.query(apply?'COMMIT':'ROLLBACK');report.applied=apply;report.finished_at=new Date().toISOString();
 if(apply){
  fs.writeFileSync(receiptFile,JSON.stringify(report,null,2));
  const oldScope='.vercel/database-migration/account-import-scope.json';
  if(fs.existsSync(oldScope)){const previous=JSON.parse(fs.readFileSync(oldScope,'utf8'));fs.writeFileSync(oldScope,JSON.stringify({...previous,preserve_all_current_account_pages:false,superseded_by:'veo-reset',page_ids:ids},null,2));}
 }
 console.log(JSON.stringify({applied:report.applied,setup_verified:report.setup_verified,pages:report.known_pages,retained:report.retained,pending_pages:report.pending_page_names}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({error:e.message,detail:e.detail,code:e.code}));process.exitCode=1;}finally{await db.end();}
