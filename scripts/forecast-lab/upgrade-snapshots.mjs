// Upgrade the exact audited snapshot, never a newer live source or contact state.
import fs from 'node:fs';import readline from 'node:readline';import pg from 'pg';import{createRequire}from'node:module';
const{parse}=createRequire(import.meta.url)('../../../node_modules/dotenv');
const env=parse(fs.readFileSync(new URL('../../.env.local',import.meta.url))),apply=process.argv.includes('--apply');
const cutoff=JSON.parse(fs.readFileSync(new URL('../../../data/conversion-forecast-prototype/metadata.json',import.meta.url))).source_cutoff_utc;
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,query_timeout:60000});
let batch=[],read=0,updated=0;
try{
 await db.connect();await db.query('BEGIN');
 const flush=async()=>{if(!batch.length)return;const r=await db.query(`UPDATE contact_conversion_cache f SET snapshots=(
 SELECT COALESCE(jsonb_agg(CASE WHEN a.signal IS NULL THEN e.snapshot ELSE e.snapshot||jsonb_build_object(
 'inbound',(a.signal->>1)::int,'quoted',(a.signal->>2)::int=1,'form',(a.signal->>3)::int=1,
 'duration',(a.signal->>4)::int=1,'returned',(a.signal->>5)::int=1,'price_question',(a.signal->>6)::int=1,
 'last_inbound_h',(a.signal->>7)::numeric) END ORDER BY e.ordinal),'[]'::jsonb)
 FROM jsonb_array_elements(f.snapshots) WITH ORDINALITY e(snapshot,ordinal)
 LEFT JOIN LATERAL (SELECT signal FROM jsonb_array_elements(s.signals) signal WHERE signal->>0=e.snapshot->>'h') a ON TRUE
 ),updated_at=clock_timestamp()
 FROM jsonb_to_recordset($1::jsonb) s(fb_page_id text,psid text,first_at timestamptz,signals jsonb),pages p,contacts c
 WHERE p.fb_page_id=s.fb_page_id AND c.page_id=p.id AND c.psid=s.psid AND f.contact_id=c.id AND f.page_id=c.page_id
 AND f.source_kind='audited_history' AND f.source_cutoff_at=$2::timestamptz AND f.first_inquiry_at=s.first_at
 AND NOT COALESCE(f.snapshots->0 ? 'inbound',false)`,[JSON.stringify(batch),cutoff]);updated+=r.rowCount;batch=[];if(read%5000===0)console.log(JSON.stringify({read,updated,committed:false}));};
 for await(const line of readline.createInterface({input:fs.createReadStream(new URL('../../../data/conversion-forecast-prototype/features.jsonl',import.meta.url)),crlfDelay:Infinity})){
  if(!line)continue;const r=JSON.parse(line);batch.push({fb_page_id:r.id.split('_')[0],psid:r.psid,first_at:new Date(r.first).toISOString(),signals:r.snapshots.map(s=>[s.h,s.inbound,...['quoted','form','duration','returned','price_question'].map(k=>Number(s[k])),s.last_inbound_h])});read++;if(batch.length===500)await flush();
 }
 await flush();await db.query(apply?'COMMIT':'ROLLBACK');
 console.log(JSON.stringify({applied:apply,rows_read:read,snapshots_upgraded:updated,source_cutoff:cutoff,newer_sources_overwritten:0,contact_permissions_changed:0,messages_sent:0}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({error:e.message}));process.exitCode=1;}finally{await db.end();}
