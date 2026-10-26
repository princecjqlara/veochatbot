import fs from 'node:fs';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import pg from 'pg';
const require=createRequire(import.meta.url),{parse}=require('../../node_modules/dotenv');
const env={...parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),...process.env};
const actions=process.argv.filter(x=>['--preflight','--apply-schema','--seed-audited','--verify'].includes(x));
if(actions.length!==1)throw Error('Choose exactly one release phase');
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,query_timeout:45000});
await db.connect();
try{
 const sql=fs.readFileSync(new URL('../supabase/migrations/202610270001_ad_lead_quality.sql',import.meta.url),'utf8');
 if(actions[0]==='--preflight'){
  await db.query('BEGIN');
  try{await db.query(sql.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,''));await db.query(fs.readFileSync(new URL('./verify-ad-lead-quality.sql',import.meta.url),'utf8'));}
  finally{await db.query('ROLLBACK');}
  console.log(JSON.stringify({phase:'preflight',passed:true,sql_invariants:14,fixtures_rolled_back:true,customer_messages_sent:0}));
 }else if(actions[0]==='--apply-schema'){
  await db.query(sql);console.log(JSON.stringify({phase:'schema',applied:true,customer_messages_sent:0}));
 }else if(actions[0]==='--seed-audited'){
  const file=new URL('../../data/conversion-forecast-prototype/features.jsonl',import.meta.url),meta=JSON.parse(fs.readFileSync(new URL('../../data/conversion-forecast-prototype/metadata.json',import.meta.url)));
  const cutoff=Date.parse(meta.source_cutoff_utc);let loaded=0,batch=[];
  await db.query('BEGIN');
  try{
   await db.query('CREATE TEMP TABLE ad_audit_seed(fb_page_id text,psid text,first_at timestamptz,message_id text) ON COMMIT DROP');
   const flush=async()=>{if(!batch.length)return;await db.query('INSERT INTO ad_audit_seed SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(fb_page_id text,psid text,first_at timestamptz,message_id text)',[JSON.stringify(batch)]);batch=[];};
   for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){if(!line)continue;const r=JSON.parse(line);if(!r.first_message_id||r.first>cutoff||r.observed!==cutoff)throw Error('Invalid audited inquiry source');batch.push({fb_page_id:r.id.split('_')[0],psid:r.psid,first_at:new Date(r.first).toISOString(),message_id:r.first_message_id});loaded++;if(batch.length===1000)await flush();}
   await flush();
   const saved=await db.query(`INSERT INTO ad_contact_sources AS existing(contact_id,page_id,first_inquiry_at,first_message_id,inquiry_basis)
    SELECT c.id,c.page_id,s.first_at,s.message_id,'audited_history' FROM ad_audit_seed s JOIN pages p ON p.fb_page_id=s.fb_page_id JOIN contacts c ON c.page_id=p.id AND c.psid=s.psid
    ON CONFLICT(contact_id) DO UPDATE SET first_inquiry_at=EXCLUDED.first_inquiry_at,first_message_id=EXCLUDED.first_message_id,inquiry_basis='audited_history',
      origin_ad_id=CASE WHEN EXCLUDED.first_inquiry_at<existing.first_inquiry_at THEN NULL ELSE existing.origin_ad_id END,
      origin_evidence_key=CASE WHEN EXCLUDED.first_inquiry_at<existing.first_inquiry_at THEN NULL ELSE existing.origin_evidence_key END,
      attribution_status=CASE WHEN EXCLUDED.first_inquiry_at<existing.first_inquiry_at THEN 'unknown' ELSE existing.attribution_status END,updated_at=clock_timestamp()
    WHERE existing.first_inquiry_at IS NULL OR EXCLUDED.first_inquiry_at<existing.first_inquiry_at OR existing.inquiry_basis='legacy_recorded'`);
   await db.query('COMMIT');console.log(JSON.stringify({phase:'audited-inquiry-seed',loaded_source_records:loaded,matched_or_refined:saved.rowCount,source_cutoff_utc:meta.source_cutoff_utc,ad_assignments_invented:0,crm_contacts_changed:0}));
  }catch(e){await db.query('ROLLBACK');throw e;}
 }else{
  const tables=(await db.query("SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename IN ('ad_tracking_settings','ad_contact_sources','ad_referral_events','ad_source_catalog','ad_lead_stage_events')")).rows;
  const totals=(await db.query("SELECT p.name,q->>'inquiries' inquiries,q->>'attributed' attributed,q->>'not_qualified' not_qualified,q->>'legacy_dates' legacy_dates FROM pages p CROSS JOIN LATERAL get_ad_lead_quality(p.id,NULL,clock_timestamp()) q WHERE p.fb_page_id=ANY($1::text[])",[['656646850875530','717828411409985','725843003947429','619355471260631','781078668411527']])).rows;
  console.log(JSON.stringify({phase:'verify',tables,totals,source_count:(await db.query('SELECT count(*)::int AS n FROM ad_contact_sources')).rows[0].n}));
 }
}catch(e){console.error(JSON.stringify({phase:actions[0],code:e.code||null,message:String(e.message).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[redacted connection]')}));process.exitCode=1;}
finally{await db.end();}
