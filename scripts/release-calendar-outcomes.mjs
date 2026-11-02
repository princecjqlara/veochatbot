import fs from 'node:fs';import assert from 'node:assert/strict';import pg from 'pg';
const apply=process.argv.includes('--apply');assert(apply||process.argv.includes('--preflight'),'Choose --preflight or --apply');
const version='202611020006',name='calendar_outcome_sources',sql=fs.readFileSync('supabase/migrations/'+version+'_'+name+'.sql','utf8').replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,query_timeout:120000});
const receipt={applied:false,preflight:!apply,financial_records_created:0,customer_messages_sent:0};
try{
 await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
 const invariant=async()=>(await db.query("SELECT (SELECT count(*) FROM contact_tags)::int AS tags,(SELECT count(*) FROM ad_daily_spend)::int AS spend_rows,(SELECT count(*) FROM contact_verified_payments)::int AS payments,(SELECT md5(string_agg(to_jsonb(c)::text,',' ORDER BY page_id)) FROM chatbot_configs c) AS bots")).rows[0];
 const before=await invariant();await db.query(sql);assert.deepEqual(await invariant(),before);
 assert.equal((await db.query("SELECT has_function_privilege('anon','public.ad_calendar_outcomes(uuid[],timestamptz,timestamptz,text)','EXECUTE') AS allowed")).rows[0].allowed,false);
 const ids=(await db.query('SELECT id FROM pages ORDER BY id LIMIT 50')).rows.map(r=>r.id);
 const report=(await db.query("SELECT get_ad_calendar_report($1,'2026-10-01T00:00:00+08','2026-11-01T00:00:00+08',NULL) AS data",[ids])).rows[0].data;
 const count=(await db.query("SELECT count(*)::int AS n FROM ad_calendar_cohort($1,'2026-10-01T00:00:00+08','2026-11-01T00:00:00+08',NULL)",[ids])).rows[0].n;
 assert.equal(report.groups.reduce((n,g)=>n+Number(g.inquiries),0),count);
 const totals=Object.fromEntries(['inquiries','converted','orders','confirmed_payers','chat_confirmed_payers','payers','reviewed_conversations'].map(key=>[key,report.groups.reduce((n,g)=>n+Number(g[key]||0),0)]));
 assert(totals.confirmed_payers>=totals.payers);assert(totals.confirmed_payers<=totals.inquiries);
 if(apply){
  await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT(version) DO NOTHING',[version,'Read existing chat confirmations and all-source calendar outcomes without changing financial records']);
  await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING',[version,name,[sql]]);
  await db.query('COMMIT');receipt.applied=true;
 }else await db.query('ROLLBACK');
 Object.assign(receipt,{passed:true,october:totals,tags_finances_and_bot_settings_preserved:true});
}catch(e){await db.query('ROLLBACK').catch(()=>{});Object.assign(receipt,{passed:false,error:e.message});process.exitCode=1;}
finally{await db.end();fs.writeFileSync('.vercel/calendar-outcomes-'+(apply?'apply':'preflight')+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
