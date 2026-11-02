// Reconcile retained full histories without AI, customer sends or inferred cash.
import fs from'node:fs';import path from'node:path';import crypto from'node:crypto';import{spawn}from'node:child_process';import{fileURLToPath}from'node:url';import{createRequire}from'node:module';import{build}from'esbuild';import pg from'pg';
import{gunzipSync}from'node:zlib';
import {markRetainedCalendarCacheSql} from './lib/calendar-source-registry.mjs';
const apply=process.argv.includes('--apply');if(Number(apply)+Number(process.argv.includes('--preflight'))!==1)throw Error('Choose exactly --preflight or --apply');
const root=path.resolve('..'),dir=path.resolve(process.argv.find(arg=>arg.startsWith('--audit-dir='))?.slice(12)||'.vercel/historical-leads');
if(dir!==path.resolve('.vercel/historical-leads')&&!dir.startsWith(path.resolve('.vercel/historical-leads')+path.sep))throw Error('Invalid audit directory');
const audit=JSON.parse(fs.readFileSync(path.join(dir,'audit.json'),'utf8'));
if(!audit.passed||!audit.read_only||!Number.isFinite(Date.parse(audit.completed_at))||Date.parse(audit.completed_at)>Date.now()+60000||Date.now()-Date.parse(audit.completed_at)>86400000)throw Error('A complete recent source audit is required');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex'),manifestText=fs.readFileSync(path.join(dir,'manifest.jsonl'),'utf8');
const allCandidates=manifestText.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(r=>r.contact_id&&r.complete&&(r.first_date_mismatch||r.source_date_mismatch||r.missing_stage_events||r.projection_cache||r.source_reviewed));
const offsetArg=process.argv.find(arg=>arg.startsWith('--batch-offset='));
if(!offsetArg){
 const phase=apply?'apply':'preflight',summaryFile=path.join(dir,'repair-'+phase+'.json'),prior=fs.existsSync(summaryFile)?JSON.parse(fs.readFileSync(summaryFile,'utf8')):null;
 const resumable=apply&&prior?.applied&&!prior.passed&&prior.manifest_sha256===digest(manifestText);
 const summary=resumable?{...prior,batches:prior.batches.filter(batch=>batch.passed&&batch.applied)}:{run_id:crypto.randomUUID(),applied:false,manifest_sha256:digest(manifestText),candidate_contacts:allCandidates.length,batches:[],ai_calls:0,ai_jobs_created:0,customer_messages_sent:0,financial_records_created:0},run=summary.run_id,completedBatches=summary.batches.length;
 const flush=()=>fs.writeFileSync(path.join(dir,'repair-'+phase+'.json'),JSON.stringify(summary,null,2));
 for(let offset=0;offset<allCandidates.length;offset+=250){
  if(offset<completedBatches*250)continue;
  let result;for(let attempt=0;attempt<3;attempt++){
   await new Promise(resolve=>{const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--'+phase,'--batch-offset='+offset,'--run-id='+run,'--audit-dir='+dir],{stdio:'ignore',windowsHide:true});child.once('exit',resolve);});
   const file=path.join(dir,'repair-'+phase+'-batch-'+offset+'.json');if(!fs.existsSync(file))throw Error('Repair batch did not write a receipt');result=JSON.parse(fs.readFileSync(file,'utf8'));if(result.run_id!==run)throw Error('Stale batch receipt');
   if(result.passed||!['40001','40P01','55P03','ENETUNREACH','ECONNRESET','ETIMEDOUT','ECONNREFUSED','57P01','08006'].includes(result.code))break;
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  summary.batches.push(result);flush();console.log(JSON.stringify({phase,batch:summary.batches.length,processed:Math.min(offset+250,allCandidates.length),total:allCandidates.length,passed:result.passed,error:result.error}));
  if(!result.passed){summary.passed=false;summary.error=result.error;summary.applied=apply&&summary.batches.some(batch=>batch.applied);flush();process.exitCode=1;break;}
 }
 if(summary.batches.every(batch=>batch.passed)){for(const key of ['inquiry_sources_refined','contact_dates_corrected','stage_events_imported','pipeline_stages_corrected','history_tags_added','protected_newer_decisions','journal_contacts','projection_sources_refreshed'])summary[key]=summary.batches.reduce((sum,batch)=>sum+(batch[key]||0),0);summary.passed=true;summary.error=undefined;summary.applied=apply;summary.completed_at=new Date().toISOString();flush();}
 console.log(JSON.stringify({...summary,batches:summary.batches.length},null,2));
 process.exit(summary.passed?0:1);
}
const batchOffset=Number(offsetArg.slice(15));if(!Number.isInteger(batchOffset)||batchOffset<0)throw Error('Invalid batch offset');
const candidates=allCandidates.slice(batchOffset,batchOffset+250);
await build({entryPoints:['src/lib/messenger-stage-sync.ts'],outfile:path.join(dir,'repair-parser.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const{parseMessengerStageEvent}=createRequire(import.meta.url)(path.join(dir,'repair-parser.cjs'));
const assert=(v,message)=>{if(!v)throw Error(message);};
for(const r of candidates){
 const sourcePath=path.resolve(root,r.archive_path);assert(sourcePath.startsWith(root+path.sep),'Source escaped workspace');const data=fs.readFileSync(sourcePath),text=(sourcePath.endsWith('.gz')?gunzipSync(data).toString('utf8'):data.toString('utf8')).replace(/^\uFEFF/,'');assert(digest(text)===r.archive_sha256,'Source changed since audit');
 const messages=JSON.parse(text).messages||[],byId=new Map(messages.map(m=>[m.id,m]));
 if(r.first_message_id){const first=byId.get(r.first_message_id);assert(first?.from?.id===r.psid&&Date.parse(first.created_time)===Date.parse(r.first_inquiry_at),'First-inquiry proof does not match its customer or time');}
 for(const e of r.stage_events){const parsed=parseMessengerStageEvent(byId.get(e.messageId)||{},r.fb_page_id);assert(JSON.stringify(parsed)===JSON.stringify(e),'Stage evidence changed');assert(Date.parse(e.occurredAt)<=Date.parse(r.source_cutoff_at),'Stage exceeds its source cutoff');}
 if(r.projection_cache){const cache=r.projection_cache;assert(cache.contact_id===r.contact_id&&cache.page_id===r.page_id&&cache.complete_history&&cache.source_cutoff_at===new Date(r.source_cutoff_at).toISOString(),'Projection identity or cutoff changed');if(cache.payment_evidence_id){const proof=byId.get(cache.payment_evidence_id);assert(proof&&Date.parse(proof.created_time)===Date.parse(cache.payment_at),'Payment source is absent or has a different time');}}
}
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},query_timeout:180000,connectionTimeoutMillis:15000});db.on('error',()=>{});
const run=process.argv.find(arg=>arg.startsWith('--run-id='))?.slice(9)||crypto.randomUUID(),receipt={run_id:run,applied:false,manifest_sha256:digest(manifestText),candidate_contacts:candidates.length,ai_calls:0,ai_jobs_created:0,customer_messages_sent:0,financial_records_created:0};
const migrations=['202611020008_historical_repair_no_ai','202611020009_calendar_historical_conversions'];
try{
 receipt.phase='connecting';await db.connect();
 // Transaction-scoped locks cannot leak through a transaction pooler. Fail
 // immediately on contention rather than waiting with a stale RR snapshot.
 receipt.phase='locking';
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'");
 if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('historical_lead_repair_v2')) AS locked")).rows[0].locked)throw Object.assign(Error('Another historical repair is running; saved checkpoints are retained'),{code:'55P03'});
 receipt.phase='preparing';
 await db.query("SELECT set_config('app.historical_lead_repair','deterministic_only',true)");
 for(const name of migrations){const sql=fs.readFileSync('supabase/migrations/'+name+'.sql','utf8');await db.query(sql.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,''));}
 await db.query("CREATE TABLE IF NOT EXISTS app_private.lead_reconciliation_changes(run_id uuid NOT NULL,contact_id uuid NOT NULL,page_id uuid NOT NULL,before_data jsonb NOT NULL,after_data jsonb NOT NULL,evidence jsonb NOT NULL,repaired_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(run_id,contact_id)); REVOKE ALL ON app_private.lead_reconciliation_changes FROM PUBLIC,anon,authenticated");
 await db.query('CREATE TEMP TABLE repair_input(contact_id uuid PRIMARY KEY,page_id uuid,psid text,first_inquiry_at timestamptz,first_message_id text,source_cutoff_at timestamptz,stage_events jsonb,archive_path text,archive_sha256 text,projection_cache jsonb) ON COMMIT DROP');
 for(let offset=0;offset<candidates.length;offset+=500)await db.query('INSERT INTO repair_input SELECT contact_id,page_id,psid,first_inquiry_at,first_message_id,source_cutoff_at,stage_events,archive_path,archive_sha256,projection_cache FROM jsonb_to_recordset($1::jsonb) AS x(contact_id uuid,page_id uuid,psid text,first_inquiry_at timestamptz,first_message_id text,source_cutoff_at timestamptz,stage_events jsonb,archive_path text,archive_sha256 text,projection_cache jsonb)',[JSON.stringify(candidates.slice(offset,offset+500))]);
 assert((await db.query('SELECT count(*)::int AS n FROM repair_input r JOIN contacts c ON c.id=r.contact_id AND c.page_id=r.page_id AND c.psid=r.psid')).rows[0].n===candidates.length,'Contact identity changed after audit');
 const invariant=async()=>(await db.query("SELECT (SELECT md5(string_agg(to_jsonb(b)::text,',' ORDER BY b.page_id)) FROM chatbot_configs b) AS bots,(SELECT md5(string_agg(to_jsonb(p)::text,',' ORDER BY to_jsonb(p)::text)) FROM contact_verified_payments p) AS payments,(SELECT md5(string_agg(to_jsonb(a)::text,',' ORDER BY to_jsonb(a)::text)) FROM ad_daily_spend a) AS spend,(SELECT md5(string_agg(to_jsonb(j)::text,',' ORDER BY j.contact_id)) FROM contact_profile_jobs j) AS ai_jobs")).rows[0];
 const beforeInvariant=await invariant();
 const stageCounts=async()=>(await db.query('SELECT p.name,c.pipeline_stage,count(*)::int AS contacts FROM contacts c JOIN pages p ON p.id=c.page_id WHERE c.page_id IN(SELECT page_id FROM repair_input) GROUP BY 1,2 ORDER BY 1,2')).rows;
 receipt.before_stages=await stageCounts();
 await db.query("CREATE TEMP TABLE repair_before ON COMMIT DROP AS SELECT c.id,c.page_id,c.first_interaction_at,c.pipeline_stage,c.pipeline_stage_source,c.pipeline_stage_updated_at,c.messenger_stage_event_at,c.messenger_stage_message_id,to_jsonb(s) AS source,CASE WHEN r.projection_cache IS NOT NULL AND r.projection_cache<>'null'::jsonb THEN to_jsonb(f) END AS conversion_cache FROM contacts c JOIN repair_input r ON r.contact_id=c.id LEFT JOIN ad_contact_sources s ON s.contact_id=c.id LEFT JOIN contact_conversion_cache f ON f.contact_id=c.id");
 await db.query('CREATE TEMP TABLE repair_tags_before ON COMMIT DROP AS SELECT t.contact_id,t.tag_id FROM contact_tags t JOIN repair_input r ON r.contact_id=t.contact_id');
 await db.query("CREATE TEMP TABLE repair_protected ON COMMIT DROP AS SELECT c.id FROM contacts c JOIN repair_input r ON r.contact_id=c.id WHERE c.pipeline_stage_source<>'system' AND c.pipeline_stage_updated_at>r.source_cutoff_at OR EXISTS(SELECT 1 FROM jsonb_array_elements(r.stage_events) e GROUP BY e->>'occurredAt' HAVING count(DISTINCT e->>'stage')>1)");
 receipt.protected_newer_decisions=(await db.query('SELECT count(*)::int AS n FROM repair_protected')).rows[0].n;
 const sources=await db.query("INSERT INTO ad_contact_sources AS s(contact_id,page_id,first_inquiry_at,first_message_id,inquiry_basis) SELECT contact_id,page_id,first_inquiry_at,first_message_id,'audited_history' FROM repair_input WHERE first_inquiry_at IS NOT NULL AND first_message_id IS NOT NULL ON CONFLICT(contact_id) DO UPDATE SET first_inquiry_at=EXCLUDED.first_inquiry_at,first_message_id=EXCLUDED.first_message_id,inquiry_basis='audited_history',origin_ad_id=CASE WHEN s.first_message_id IS NOT DISTINCT FROM EXCLUDED.first_message_id THEN s.origin_ad_id END,origin_evidence_key=CASE WHEN s.first_message_id IS NOT DISTINCT FROM EXCLUDED.first_message_id THEN s.origin_evidence_key END,attribution_status=CASE WHEN s.first_message_id IS NOT DISTINCT FROM EXCLUDED.first_message_id THEN s.attribution_status ELSE 'unknown' END,updated_at=clock_timestamp() WHERE s.page_id=EXCLUDED.page_id AND (s.first_inquiry_at IS NULL OR s.inquiry_basis='legacy_recorded' OR EXCLUDED.first_inquiry_at<s.first_inquiry_at AND (s.first_message_id IS NOT DISTINCT FROM EXCLUDED.first_message_id OR s.first_message_id IS NULL OR date_trunc('second',EXCLUDED.first_inquiry_at)<date_trunc('second',s.first_inquiry_at)))");
 receipt.inquiry_sources_refined=sources.rowCount;
 const projections=await db.query("SELECT save_contact_conversion_cache(r.page_id,r.contact_id,r.projection_cache) FROM repair_input r WHERE r.projection_cache IS NOT NULL AND r.projection_cache<>'null'::jsonb");receipt.projection_sources_refreshed=projections.rowCount;
 // The shared Graph refresh function writes live_graph. Retained exports keep
 // their audited provenance; an equal/newer existing live read is preserved.
 await db.query(markRetainedCalendarCacheSql);
 assert((await db.query("SELECT count(*)::int AS n FROM repair_before b LEFT JOIN contact_conversion_cache f ON f.contact_id=b.id WHERE b.conversion_cache->>'payment_at' IS NOT NULL AND (f.payment_at IS NULL OR f.payment_at>(b.conversion_cache->>'payment_at')::timestamptz)")).rows[0].n===0,'Existing payment confirmations must not disappear or move to a later date');
 const dates=await db.query("UPDATE contacts c SET first_interaction_at=s.first_inquiry_at FROM repair_input r JOIN ad_contact_sources s ON s.contact_id=r.contact_id AND s.page_id=r.page_id WHERE c.id=r.contact_id AND c.page_id=r.page_id AND r.first_inquiry_at IS NOT NULL AND s.first_inquiry_at IS NOT NULL AND s.inquiry_basis<>'legacy_recorded' AND c.first_interaction_at IS DISTINCT FROM s.first_inquiry_at");
 receipt.contact_dates_corrected=dates.rowCount;
 receipt.before_stage_events=(await db.query('SELECT count(*)::int AS n FROM messenger_lead_stage_events')).rows[0].n;
 await db.query(`DO $repair$
 DECLARE item RECORD; evidence JSONB; inserted BIGINT;
 BEGIN
  FOR item IN SELECT r.*,p.id IS NOT NULL AS protected FROM repair_input r LEFT JOIN repair_protected p ON p.id=r.contact_id ORDER BY r.contact_id LOOP
   FOR evidence IN SELECT value FROM jsonb_array_elements(item.stage_events) ORDER BY (value->>'occurredAt')::timestamptz,value->>'messageId' LOOP
    IF item.protected THEN
     INSERT INTO messenger_lead_stage_events(page_id,contact_id,message_id,label,stage,occurred_at)
      VALUES(item.page_id,item.contact_id,evidence->>'messageId',evidence->>'label',evidence->>'stage',(evidence->>'occurredAt')::timestamptz)
      ON CONFLICT(page_id,message_id) DO NOTHING RETURNING id INTO inserted;
     IF inserted IS NOT NULL THEN PERFORM add_contact_stage_history_tag(item.page_id,item.contact_id,evidence->>'label',evidence->>'stage'); END IF;
    ELSE
     PERFORM apply_messenger_lead_stage(item.page_id,item.contact_id,evidence->>'messageId',evidence->>'label',evidence->>'stage',(evidence->>'occurredAt')::timestamptz);
    END IF;
   END LOOP;
  END LOOP;
 END $repair$`);
 receipt.stage_events_imported=(await db.query('SELECT count(*)::int AS n FROM messenger_lead_stage_events')).rows[0].n-receipt.before_stage_events;
 receipt.pipeline_stages_corrected=(await db.query('SELECT count(*)::int AS n FROM repair_before b JOIN contacts c ON c.id=b.id WHERE c.pipeline_stage IS DISTINCT FROM b.pipeline_stage')).rows[0].n;
 assert((await db.query('SELECT count(*)::int AS n FROM (SELECT * FROM repair_tags_before EXCEPT SELECT contact_id,tag_id FROM contact_tags) x')).rows[0].n===0,'Existing tags must not be removed');
 receipt.history_tags_added=(await db.query('SELECT count(*)::int AS n FROM contact_tags t JOIN repair_input r ON r.contact_id=t.contact_id WHERE NOT EXISTS(SELECT 1 FROM repair_tags_before b WHERE b.contact_id=t.contact_id AND b.tag_id=t.tag_id)')).rows[0].n;
 const journal=await db.query("INSERT INTO app_private.lead_reconciliation_changes(run_id,contact_id,page_id,before_data,after_data,evidence) SELECT $1,c.id,c.page_id,to_jsonb(b)-'id'-'page_id',jsonb_build_object('first_interaction_at',c.first_interaction_at,'pipeline_stage',c.pipeline_stage,'pipeline_stage_source',c.pipeline_stage_source,'messenger_stage_event_at',c.messenger_stage_event_at,'messenger_stage_message_id',c.messenger_stage_message_id,'source',to_jsonb(s),'conversion_cache',CASE WHEN r.projection_cache IS NOT NULL AND r.projection_cache<>'null'::jsonb THEN to_jsonb(f) END),jsonb_build_object('archive_path',r.archive_path,'archive_sha256',r.archive_sha256,'source_cutoff_at',r.source_cutoff_at,'first_message_id',r.first_message_id,'stage_events',r.stage_events) FROM repair_input r JOIN contacts c ON c.id=r.contact_id JOIN repair_before b ON b.id=c.id LEFT JOIN ad_contact_sources s ON s.contact_id=c.id LEFT JOIN contact_conversion_cache f ON f.contact_id=c.id",[run]);receipt.journal_contacts=journal.rowCount;
 assert(JSON.stringify(await invariant())===JSON.stringify(beforeInvariant),'Bot settings, AI jobs, verified payments and ad spend must remain unchanged');
 assert((await db.query('SELECT count(*)::int AS n FROM repair_protected p JOIN contacts c ON c.id=p.id JOIN repair_before b ON b.id=p.id WHERE c.pipeline_stage IS DISTINCT FROM b.pipeline_stage OR c.pipeline_stage_source IS DISTINCT FROM b.pipeline_stage_source OR c.messenger_stage_message_id IS DISTINCT FROM b.messenger_stage_message_id')).rows[0].n===0,'Newer local decisions must remain unchanged');
 receipt.after_stages=await stageCounts();
 if(apply)for(const fullName of migrations){const version=fullName.slice(0,12),name=fullName.slice(13),sql=fs.readFileSync('supabase/migrations/'+fullName+'.sql','utf8');await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT DO NOTHING',[version,name]);await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT DO NOTHING',[version,name,[sql]]);}
 receipt.phase='finishing';await db.query(apply?'COMMIT':'ROLLBACK');receipt.applied=apply;receipt.passed=true;receipt.phase='completed';
}catch(e){await db.query('ROLLBACK').catch(()=>{});receipt.passed=false;receipt.error=e.message||e.code||'Database connection failed';receipt.code=e.code;process.exitCode=1;}
finally{await db.end();fs.writeFileSync(path.join(dir,'repair-'+(apply?'apply':'preflight')+'-batch-'+batchOffset+'.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
