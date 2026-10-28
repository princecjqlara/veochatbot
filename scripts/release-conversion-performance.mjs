import fs from'node:fs';import pg from'pg';import{createRequire}from'node:module';
const{parse}=createRequire(import.meta.url)('../../node_modules/dotenv'),env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),apply=process.argv.includes('--apply');
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const sql=fs.readFileSync(new URL('../supabase/migrations/202610290001_conversion_performance.sql',import.meta.url),'utf8');
try{
 await db.connect();
 if(apply){await db.query(sql);console.log(JSON.stringify({applied:true,customer_messages_sent:0,contact_permissions_changed:0}));}
 else{
  await db.query('BEGIN');await db.query(sql.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,''));
  await db.query(`DO $$ DECLARE p UUID:=gen_random_uuid();a UUID:=gen_random_uuid();b UUID:=gen_random_uuid();c UUID:=gen_random_uuid();
   t TIMESTAMPTZ:=date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila';r JSONB;s JSONB; BEGIN
   INSERT INTO pages(id,fb_page_id,name,access_token) VALUES(p,'verify-performance-'||p,'Performance fixture','not-a-token');
   INSERT INTO contacts(id,page_id,psid,first_interaction_at,last_interaction_at,pipeline_stage) VALUES
    (a,p,a::text,t-interval '2 days',t+interval '1 second','new'),
    (b,p,b::text,t-interval '1 day',t-interval '1 second','new'),
    (c,p,c::text,t+interval '2 seconds',t+interval '3 seconds','converted');
   INSERT INTO ad_contact_sources(contact_id,page_id,first_inquiry_at,origin_ad_id,inquiry_basis) VALUES
    (a,p,t-interval '2 days','123','live_message'),(b,p,t-interval '1 day','123','live_message'),(c,p,t+interval '2 seconds','456','live_message');
   INSERT INTO contact_conversion_cache(contact_id,page_id,first_inquiry_at,source_cutoff_at,payment_at,payment_evidence_id,complete_history,source_kind,snapshots) VALUES
    (a,p,t-interval '2 days',clock_timestamp(),t+interval '1 second','fixture-first-payment',true,'live_graph','[]'),
    (b,p,t-interval '1 day',clock_timestamp(),t-interval '1 second','fixture-old-payment',true,'live_graph','[]'),
    (c,p,t+interval '2 seconds',t+interval '30 seconds',null,null,true,'live_graph','[{"h":0,"b":"initial_inquiry"}]');
   r:=get_conversion_period_payments(ARRAY[p],t,t+interval '1 day');
   ASSERT jsonb_array_length(r)=1 AND (r->0->>'confirmed')::int=1,'Payment-day count includes a different day or misses an older-inquiry payer';
   ASSERT abs((r->0->>'avg_hours')::numeric-(48+1.0/3600))<.000001,'Inquiry-to-payment time uses wrong dates';
   r:=get_conversion_report_inputs(ARRAY[p],t,t+interval '1 day',NULL,1000);
   ASSERT jsonb_array_length(r->'rows')=1 AND r->'rows'->0->>'id'=c::text,'Today acquisition cohort contains an older lead who paid today';
   ASSERT (r->'rows'->0->>'payment_at') IS NULL,'CRM converted was treated as payment proof';
   PERFORM mark_conversion_source_dirty(p,c::text,t+interval '31 seconds');
   ASSERT (SELECT dirty_at>source_cutoff_at FROM contact_conversion_cache WHERE contact_id=c),'Page reply did not invalidate unpaid source';
   PERFORM mark_conversion_source_dirty(p,c::text,t+interval '10 seconds');
   ASSERT (SELECT dirty_at=t+interval '31 seconds' FROM contact_conversion_cache WHERE contact_id=c),'Older echo regressed dirty timestamp';
   r:=get_conversion_refresh_candidates(ARRAY[p],t,t+interval '1 day','{}',8);
   ASSERT (r->>'pending')::int=1,'Evidence queue did not include CRM converted without documentary proof';
   r:=get_conversion_refresh_candidates(ARRAY[p],t,t+interval '1 day',ARRAY[c],8);
   ASSERT (r->>'pending')::int=0,'Failed/skipped contact could loop in the same verification run';
   INSERT INTO contacts(id,page_id,psid,first_interaction_at) SELECT gen_random_uuid(),p,'fixture-'||i,t+interval '2 seconds' FROM generate_series(1,1001)i;
   r:=get_conversion_report_inputs(ARRAY[p],NULL,t+interval '1 day',NULL,1000);
   ASSERT jsonb_array_length(r->'rows')=1000 AND (r->>'has_more')::boolean,'Report silently truncated at 1000 leads';
   s:=get_conversion_report_inputs(ARRAY[p],NULL,t+interval '1 day',(r->>'next_after')::uuid,1000);
   ASSERT jsonb_array_length(s->'rows')=4 AND NOT(s->>'has_more')::boolean,'Keyset paging skipped or duplicated cohort records';
   INSERT INTO ad_daily_spend(page_id,ad_id,account_id,spend_date,currency,account_timezone,pht_aligned,amount) VALUES(p,'123','99',t::date,'PHP','Asia/Manila',true,100);
   INSERT INTO ad_daily_spend(page_id,ad_id,account_id,spend_date,currency,account_timezone,pht_aligned,amount) VALUES(p,'123','99',t::date,'PHP','Asia/Singapore',true,150)
    ON CONFLICT(page_id,ad_id,spend_date,account_id) DO UPDATE SET amount=EXCLUDED.amount,account_timezone=EXCLUDED.account_timezone;
   ASSERT (SELECT count(*)=1 AND sum(amount)=150 FROM ad_daily_spend WHERE page_id=p),'Refresh double-counted spend after timezone metadata changed';
   ASSERT NOT has_table_privilege('authenticated','public.ad_daily_spend','SELECT'),'Client can bypass spend Page authorization';
   ASSERT NOT has_function_privilege('anon','public.get_conversion_period_payments(uuid[],timestamp with time zone,timestamp with time zone)','EXECUTE'),'Anonymous payment summary access';
   ASSERT NOT has_function_privilege('authenticated','public.mark_conversion_source_dirty(uuid,text,timestamp with time zone)','EXECUTE'),'Client can dirty another Page source';
  END $$;`);
  await db.query('ROLLBACK');console.log(JSON.stringify({preflight:true,sql_invariants:14,fixtures_rolled_back:true,customer_messages_sent:0}));
 }
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({error:e.message}));process.exitCode=1;}finally{await db.end();}
