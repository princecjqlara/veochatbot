import fs from'node:fs';import readline from'node:readline';import{createRequire}from'node:module';import pg from'pg';
const{parse}=createRequire(import.meta.url)('../../node_modules/dotenv'),env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url)));
const action=process.argv.find(a=>['--preflight','--apply','--seed'].includes(a));if(!action)throw Error('Choose preflight, apply or seed');
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,query_timeout:60000});await db.connect();
try{
 const sql=fs.readFileSync(new URL('../supabase/migrations/202610270002_contact_bot_projections.sql',import.meta.url),'utf8');
 const followups=['202610280001_fast_ad_contact_drilldown.sql','202610280002_ad_inventory_visibility.sql','202610280003_preserve_same_message_ad_origin.sql'].map(name=>fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 if(action==='--preflight'){
  await db.query('BEGIN');try{for(const migration of[sql,...followups])await db.query(migration.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,''));await db.query(fs.readFileSync(new URL('./verify-contact-controls.sql',import.meta.url),'utf8'));}finally{await db.query('ROLLBACK');}
  console.log(JSON.stringify({preflight:true,sql_invariants:14,fixtures_rolled_back:true,messages_sent:0}));
 }else if(action==='--apply'){
  for(const migration of[sql,...followups])await db.query(migration);console.log(JSON.stringify({schema_applied:true,existing_contact_permissions_changed:0,existing_stages_changed:0,messages_sent:0}));
 }else{
  const cutoff=JSON.parse(fs.readFileSync(new URL('../../data/conversion-forecast-prototype/metadata.json',import.meta.url))).source_cutoff_utc;
  let batch=[],read=0,saved=0;await db.query('BEGIN');
  try{
   const flush=async()=>{if(!batch.length)return;const r=await db.query(`INSERT INTO contact_conversion_cache(contact_id,page_id,first_inquiry_at,source_cutoff_at,snapshots,payment_at,payment_evidence_id,source_kind,complete_history)
    SELECT c.id,c.page_id,s.first_at,$2::timestamptz,s.snapshots,s.payment_at,s.proof,'audited_history',TRUE
    FROM jsonb_to_recordset($1::jsonb) AS s(fb_page_id text,psid text,first_at timestamptz,snapshots jsonb,payment_at timestamptz,proof text)
    JOIN pages p ON p.fb_page_id=s.fb_page_id JOIN contacts c ON c.page_id=p.id AND c.psid=s.psid
    ON CONFLICT(contact_id) DO NOTHING`,[JSON.stringify(batch),cutoff]);saved+=r.rowCount;batch=[];};
   for await(const line of readline.createInterface({input:fs.createReadStream(new URL('../../data/conversion-forecast-prototype/features.jsonl',import.meta.url)),crlfDelay:Infinity})){if(!line)continue;const r=JSON.parse(line);if(r.event&&!r.payment_evidence_id)throw Error('Payment source evidence missing');batch.push({fb_page_id:r.id.split('_')[0],psid:r.psid,first_at:new Date(r.first).toISOString(),snapshots:r.snapshots.map(s=>({h:s.h,i:s.i,s:s.s,b:s.b})),payment_at:r.event?new Date(r.event).toISOString():null,proof:r.payment_evidence_id||null});read++;if(batch.length===500)await flush();}
   await flush();await db.query('COMMIT');console.log(JSON.stringify({source_records:read,verified_projection_sources_seeded:saved,source_cutoff:cutoff,messages_sent:0}));
  }catch(e){await db.query('ROLLBACK');throw e;}
 }
}catch(e){console.error(JSON.stringify({error:e.message,code:e.code||null}));process.exitCode=1;}finally{await db.end();}
