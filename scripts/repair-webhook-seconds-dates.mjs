import fs from'node:fs';import assert from'node:assert/strict';import pg from'pg';
const apply=process.argv.includes('--apply');assert(apply||process.argv.includes('--preflight'),'Choose --preflight or --apply');
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},query_timeout:120000});
const receipt={applied:false,financial_records_created:0,customer_messages_sent:0,repairs:[]};
const targets=[
 {table:'contacts',key:'id',type:'uuid',field:'first_interaction_at',join:'',start:'t.created_at',end:'t.created_at'},
 {table:'contacts',key:'id',type:'uuid',field:'last_interaction_at',join:'',start:'t.created_at',end:'t.updated_at'},
 {table:'ad_contact_sources',key:'contact_id',type:'uuid',field:'first_inquiry_at',join:'JOIN public.contacts p ON p.id=t.contact_id AND p.page_id=t.page_id',start:'p.created_at',end:'p.created_at'},
 {table:'ad_referral_events',key:'event_key',type:'text',field:'event_at',join:'',start:'t.received_at',end:'t.received_at'}
];
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
 await db.query("SET LOCAL lock_timeout='5s'");
 await db.query("CREATE TABLE IF NOT EXISTS app_private.webhook_date_repairs(table_name TEXT NOT NULL,record_id TEXT NOT NULL,column_name TEXT NOT NULL,old_value TIMESTAMPTZ NOT NULL,new_value TIMESTAMPTZ NOT NULL,repaired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),reason TEXT NOT NULL,PRIMARY KEY(table_name,record_id,column_name,old_value)); REVOKE ALL ON app_private.webhook_date_repairs FROM PUBLIC,anon,authenticated");
 await db.query('CREATE TEMP TABLE webhook_date_candidates(table_name TEXT,record_id TEXT,column_name TEXT,old_value TIMESTAMPTZ,new_value TIMESTAMPTZ) ON COMMIT DROP');
 const invariant=async()=>(await db.query("SELECT (SELECT count(*) FROM contact_tags)::int AS tags,(SELECT count(*) FROM contact_verified_payments)::int AS receipts,(SELECT count(*) FROM ad_daily_spend)::int AS spend,(SELECT md5(string_agg(to_jsonb(c)::text,',' ORDER BY page_id)) FROM chatbot_configs c) AS bots")).rows[0];
 const before=await invariant();
 for(const target of targets){
  const corrected='to_timestamp(extract(epoch FROM t.'+target.field+')*1000)';
  const bad=(await db.query('SELECT count(*)::int AS n FROM public.'+target.table+' WHERE '+target.field+"<'2000-01-01'")).rows[0].n;
  await db.query('INSERT INTO webhook_date_candidates SELECT $1,t.'+target.key+'::text,$2,t.'+target.field+','+corrected+' FROM public.'+target.table+' t '+target.join+' WHERE t.'+target.field+"<'2000-01-01' AND "+corrected+" BETWEEN "+target.start+"-interval '1 day' AND "+target.end+"+interval '1 minute' AND "+corrected+" BETWEEN '2000-01-01'::timestamptz AND statement_timestamp()+interval '1 minute'",[target.table,target.field]);
  const candidates=(await db.query('SELECT count(*)::int AS n FROM webhook_date_candidates WHERE table_name=$1 AND column_name=$2',[target.table,target.field])).rows[0].n;
  assert.equal(candidates,bad,'Every repair must match independent creation/receipt time evidence');
  receipt.repairs.push({table:target.table,column:target.field,records:candidates});
 }
 await db.query("INSERT INTO app_private.webhook_date_repairs(table_name,record_id,column_name,old_value,new_value,reason) SELECT table_name,record_id,column_name,old_value,new_value,'Unix seconds were interpreted as milliseconds; corrected date matches independent creation or receipt time' FROM webhook_date_candidates ON CONFLICT DO NOTHING");
 for(const target of targets){
  const updated=await db.query('UPDATE public.'+target.table+' t SET '+target.field+'=r.new_value FROM webhook_date_candidates r WHERE r.table_name=$1 AND r.column_name=$2 AND t.'+target.key+'=r.record_id::'+target.type+' AND t.'+target.field+'=r.old_value',[target.table,target.field]);
  assert.equal(updated.rowCount,receipt.repairs.find(r=>r.table===target.table&&r.column===target.field).records);
 }
 assert.deepEqual(await invariant(),before,'Tags, finances and bot settings must remain unchanged');
 await db.query(apply?'COMMIT':'ROLLBACK');receipt.applied=apply;receipt.passed=true;
}catch(e){await db.query('ROLLBACK').catch(()=>{});receipt.passed=false;receipt.error=e.message;process.exitCode=1;}
finally{await db.end();fs.writeFileSync('.vercel/webhook-date-repair-'+(apply?'apply':'preflight')+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
