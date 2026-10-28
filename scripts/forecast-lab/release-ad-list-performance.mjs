import fs from'node:fs';import pg from'pg';import assert from'node:assert/strict';import{createRequire}from'node:module';
const{parse}=createRequire(import.meta.url)('../../../node_modules/dotenv'),env=parse(fs.readFileSync(new URL('../../.env.local',import.meta.url))),apply=process.argv.includes('--apply');
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,query_timeout:60000});
const sql=fs.readFileSync(new URL('../../supabase/migrations/202610280001_fast_ad_contact_drilldown.sql',import.meta.url),'utf8');
try{
 await db.connect();const page=(await db.query("SELECT id FROM pages WHERE fb_page_id='656646850875530'")).rows[0].id,to=new Date().toISOString();
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
 const run=async bot=>(await db.query("SELECT get_ad_lead_contacts_v2($1,NULL,$2,NULL,FALSE,NULL,$3,25,0) AS result",[page,to,bot])).rows[0].result;
 const start=Date.now(),before=await run('all'),beforeMs=Date.now()-start;
 await db.query(sql.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,''));
 const nextStart=Date.now(),after=await run('all'),afterMs=Date.now()-nextStart;
 assert.deepEqual(after,before,'Optimized query changed the cohort or returned details');
 for(const bot of ['on','off']){const r=await run(bot);assert(r.contacts.every(c=>c.chatbot_enabled===(bot==='on')));const expected=(await db.query("SELECT count(*)::int AS n FROM ad_lead_cohorts a JOIN contacts c ON c.id=a.id WHERE a.page_id=$1 AND a.first_inquiry_at IS NOT NULL AND a.first_inquiry_at<$2 AND c.chatbot_enabled=$3",[page,to,bot==='on'])).rows[0].n;assert.equal(r.total,expected);}
 await db.query(apply?'COMMIT':'ROLLBACK');console.log(JSON.stringify({applied:apply,identical_cohort_and_contact_data:true,on_off_filters_verified:true,before_ms:beforeMs,after_ms:afterMs,customer_records_changed:0,messages_sent:0}));
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({error:e.message}));process.exitCode=1;}finally{await db.end();}
