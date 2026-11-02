import fs from'node:fs';import assert from'node:assert/strict';import pg from'pg';
const dir='.vercel/historical-leads',receipt={ai_calls:0,customer_messages_sent:0};
const applied=JSON.parse(fs.readFileSync(dir+'/repair-apply.json','utf8'));assert(applied.passed&&applied.applied,'Finish the retained-history repair first');
const rows=fs.readFileSync(dir+'/manifest.jsonl','utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.contact_id&&row.complete);
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,query_timeout:120000});db.on('error',()=>{});
try{
 await db.connect();await db.query('BEGIN');
 await db.query('CREATE TEMP TABLE expected_history(contact_id uuid,page_id uuid,message_id text,label text,stage text,occurred_at timestamptz) ON COMMIT DROP');
 const stages=rows.flatMap(row=>row.stage_events.map(event=>({contact_id:row.contact_id,page_id:row.page_id,message_id:event.messageId,label:event.label,stage:event.stage,occurred_at:event.occurredAt})));
 for(let offset=0;offset<stages.length;offset+=500)await db.query('INSERT INTO expected_history SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(contact_id uuid,page_id uuid,message_id text,label text,stage text,occurred_at timestamptz)',[JSON.stringify(stages.slice(offset,offset+500))]);
 receipt.source_notices_checked=stages.length;
 receipt.integrity=(await db.query("SELECT count(*) FILTER(WHERE e.id IS NULL)::int AS missing_notices,count(*) FILTER(WHERE e.id IS NOT NULL AND (e.contact_id<>x.contact_id OR e.label<>x.label OR e.stage<>x.stage OR e.occurred_at<>x.occurred_at))::int AS mismatched_notices,count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id=x.contact_id AND t.system_key=stage_history_tag_key(x.label)))::int AS missing_history_tags FROM expected_history x LEFT JOIN messenger_lead_stage_events e ON e.page_id=x.page_id AND e.message_id=x.message_id")).rows[0];
 assert(Object.values(receipt.integrity).every(value=>value===0),'Stored history/tags must match authenticated source notices');
 receipt.current_stages=(await db.query('SELECT p.name,c.pipeline_stage,count(*)::int AS contacts FROM contacts c JOIN pages p ON p.id=c.page_id WHERE c.page_id=ANY($1::uuid[]) GROUP BY 1,2 ORDER BY 1,2',[[...new Set(rows.map(row=>row.page_id))]])).rows;
 receipt.profile_jobs=(await db.query('SELECT status,count(*)::int AS jobs FROM contact_profile_jobs GROUP BY 1')).rows;
 receipt.repairs=Object.fromEntries(['contact_dates_corrected','inquiry_sources_refined','stage_events_imported','pipeline_stages_corrected','history_tags_added','protected_newer_decisions','ai_jobs_created'].map(key=>[key,applied[key]]));
 assert.equal(applied.ai_calls,0);assert.equal(applied.ai_jobs_created,0);
 await db.query('ROLLBACK');receipt.passed=true;
}catch(e){await db.query('ROLLBACK').catch(()=>{});receipt.passed=false;receipt.error=e.message||e.code;process.exitCode=1;}
finally{await db.end();fs.writeFileSync(dir+'/verification.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
