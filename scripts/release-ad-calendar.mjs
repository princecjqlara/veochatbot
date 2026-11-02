import fs from 'node:fs';import assert from 'node:assert/strict';import pg from 'pg';
const apply=process.argv.includes('--apply');if(!apply&&!process.argv.includes('--preflight'))throw Error('Choose --preflight or --apply');
const version='202611020005',name='ad_calendar',sql=fs.readFileSync('supabase/migrations/'+version+'_'+name+'.sql','utf8').replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,query_timeout:120000});
const receipt={at:new Date().toISOString(),applied:false,preflight:!apply};
try{await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');const invariant=async()=>(await db.query(`SELECT (SELECT count(*)::int FROM tags) AS tags,(SELECT count(*)::int FROM contact_tags) AS assignments,
 (SELECT count(*)::int FROM ad_daily_spend) AS spend_rows,(SELECT coalesce(sum(amount),0)::text FROM ad_daily_spend) AS spend,
 (SELECT count(*)::int FROM contact_verified_payments) AS payment_rows,(SELECT coalesce(sum(amount_minor),0)::text FROM contact_verified_payments) AS payment_amount,
 (SELECT md5(string_agg(to_jsonb(c)::text,',' ORDER BY page_id)) FROM chatbot_configs c) AS bots`)).rows[0];
 const before=await invariant();await db.query(sql);assert.deepEqual(await invariant(),before);
 assert.equal((await db.query("SELECT has_function_privilege('anon','public.get_ad_calendar_report(uuid[],timestamptz,timestamptz,text)','EXECUTE') AS allowed")).rows[0].allowed,false);
 const [year,month]=new Date(Date.now()+8*3600000).toISOString().slice(0,7).split('-').map(Number),from=new Date(Date.UTC(year,month-1,1)-8*3600000),to=new Date(Date.UTC(year,month,1)-8*3600000);
 const owner=(await db.query('SELECT s.page_id FROM ad_contact_sources s WHERE s.first_inquiry_at>=$1 AND s.first_inquiry_at<$2 AND EXISTS(SELECT 1 FROM user_pages up WHERE up.page_id=s.page_id) GROUP BY s.page_id ORDER BY count(*) DESC LIMIT 1',[from.toISOString(),to.toISOString()])).rows[0]||(await db.query('SELECT page_id FROM user_pages LIMIT 1')).rows[0];
 const report=(await db.query('SELECT get_ad_calendar_report($1,$2,$3,NULL) AS report',[[owner.page_id],from.toISOString(),to.toISOString()])).rows[0].report;assert(Array.isArray(report.groups));
 const expected=(await db.query('SELECT count(*)::int AS n FROM ad_lead_cohorts WHERE page_id=$1 AND first_inquiry_at>=$2 AND first_inquiry_at<least($3::timestamptz,statement_timestamp())',[owner.page_id,from.toISOString(),to.toISOString()])).rows[0].n;assert.equal(report.groups.reduce((n,row)=>n+Number(row.inquiries),0),expected);
 if(apply){await db.query('INSERT INTO app_private.schema_migrations(version,description) VALUES($1,$2) ON CONFLICT(version) DO NOTHING',[version,'PHT acquisition-day calendar, verified cohort revenue and daily ad delivery metrics']);
 await db.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3::text[]) ON CONFLICT(version) DO NOTHING',[version,name,[sql]]);await db.query('COMMIT');receipt.applied=true;}else await db.query('ROLLBACK');
 Object.assign(receipt,{passed:true,private_reporting:true,existing_tags_preserved:true,existing_spend_and_payments_preserved:true,bot_configuration_preserved:true,financial_records_created:0,cohort_groups_checked:report.groups.length});
}catch(e){await db.query('ROLLBACK').catch(()=>{});Object.assign(receipt,{passed:false,error:e.message});process.exitCode=1;}finally{await db.end();fs.writeFileSync('.vercel/calendar-schema-'+(apply?'apply':'preflight')+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
