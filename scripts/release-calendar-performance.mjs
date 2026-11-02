import fs from'node:fs';import assert from'node:assert/strict';import pg from'pg';
const apply=process.argv.includes('--apply'),prepare=process.argv.includes('--prepare-indexes');
assert(apply||prepare||process.argv.includes('--preflight'),'Choose --prepare-indexes, --preflight or --apply');
const version='202611020007',name='calendar_report_performance';
const source=fs.readFileSync('supabase/migrations/'+version+'_'+name+'.sql','utf8');
const pattern=/CREATE INDEX IF NOT EXISTS idx_(?:contacts|sources)_calendar_inquiry[\s\S]+?;/g;
const indexes=source.match(pattern);assert.equal(indexes.length,2);
const sql=source.replace(pattern,'').replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},query_timeout:120000,connectionTimeoutMillis:15000});
const receipt={applied:false,prepared_indexes:false,preflight:!apply&&!prepare,financial_records_created:0,customer_messages_sent:0};
try{
 await db.connect();
 if(prepare){for(const index of indexes)await db.query(index.replace('CREATE INDEX IF NOT EXISTS','CREATE INDEX CONCURRENTLY IF NOT EXISTS'));receipt.prepared_indexes=true;receipt.passed=true;}
 else {
  for(const index of ['idx_contacts_calendar_inquiry','idx_sources_calendar_inquiry']){
   const record=(await db.query('SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.oid=to_regclass($1)',['public.'+index])).rows[0];
   assert(record?.indisvalid,'Run --prepare-indexes before validating report performance');
  }
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const invariant=async()=>(await db.query("SELECT (SELECT count(*) FROM contact_tags)::int AS tags,(SELECT count(*) FROM contact_verified_payments)::int AS payments,(SELECT count(*) FROM ad_daily_spend)::int AS spend,(SELECT md5(string_agg(to_jsonb(c)::text,',' ORDER BY page_id)) FROM chatbot_configs c) AS bots")).rows[0];
  const before=await invariant(),ids=(await db.query('SELECT id FROM pages ORDER BY id LIMIT 50')).rows.map(r=>r.id);
  const periods=['2026-07','2026-10'];const baseline=[];
  const report=async month=>{const[y,m]=month.split('-').map(Number),start=Date.now();const data=(await db.query('SELECT get_ad_calendar_report($1,$2,$3,NULL) AS result',[ids,new Date(Date.UTC(y,m-1,1)-8*3600000),new Date(Date.UTC(y,m,1)-8*3600000)])).rows[0].result;return{data,ms:Date.now()-start};};
  for(const month of periods)baseline.push(await report(month));
  await db.query(sql);receipt.timings=[];
  for(let i=0;i<periods.length;i++){const after=await report(periods[i]);assert.deepEqual(after.data.groups,baseline[i].data.groups,'Report totals must be identical');receipt.timings.push({month:periods[i],before_ms:baseline[i].ms,after_ms:after.ms,groups:after.data.groups.length});}
  assert.deepEqual(await invariant(),before,'Tags, finances and bot settings must be preserved');
  assert(receipt.timings.every(row=>row.after_ms<6500),'Reports must leave headroom beneath the database query limit');
  assert.equal((await db.query("SELECT has_function_privilege('anon','public.ad_calendar_outcomes_core(uuid[],timestamptz,timestamptz,text,boolean)','EXECUTE') AS allowed")).rows[0].allowed,false);
  if(apply){await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT(version) DO NOTHING',[version,'Indexed calendar cohort reads, batch payment aggregation and paginated name lookups']);await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING',[version,name,[source]]);await db.query('COMMIT');receipt.applied=true;}
  else await db.query('ROLLBACK');receipt.passed=true;
 }
}catch(e){await db.query('ROLLBACK').catch(()=>{});receipt.passed=false;receipt.error=e.message;process.exitCode=1;}
finally{await db.end();fs.writeFileSync('.vercel/calendar-performance-'+(prepare?'indexes':apply?'apply':'preflight')+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
