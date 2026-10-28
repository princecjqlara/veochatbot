import fs from'node:fs';import pg from'pg';import{createRequire}from'node:module';
const{parse}=createRequire(import.meta.url)('../../node_modules/dotenv'),env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),apply=process.argv.includes('--apply');
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const sql=fs.readFileSync(new URL('../supabase/migrations/202610280002_ad_inventory_visibility.sql',import.meta.url),'utf8');
try{
 await db.connect();if(apply){await db.query(sql);console.log(JSON.stringify({schema_applied:true,contacts_changed:0,messages_sent:0}));}
 else{
  await db.query('BEGIN');await db.query(sql.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,''));
  await db.query(`DO $$ DECLARE p UUID:=gen_random_uuid(); a TEXT:='999'||extract(epoch from clock_timestamp())::bigint; r JSONB; BEGIN
   INSERT INTO pages(id,fb_page_id,name,access_token) VALUES(p,'verify-ad-visibility-'||p,'Ad visibility fixture','not-a-token');
   PERFORM save_ad_catalog_metadata(jsonb_build_array(jsonb_build_object('page_id',p,'ad_id',a,'ad_name','Actual verified name','photo_url','https://example.com/poster.jpg','video_url','https://example.com/video.mp4','metadata_source','marketing_api','metadata_status','available')));
   PERFORM save_ad_catalog_metadata(jsonb_build_array(jsonb_build_object('page_id',p,'ad_id',a,'metadata_status','permissions_needed','metadata_error_code',200)));
   ASSERT (SELECT ad_name='Actual verified name' AND photo_url='https://example.com/poster.jpg' AND video_url='https://example.com/video.mp4' AND metadata_source='marketing_api' FROM ad_source_catalog WHERE page_id=p AND ad_id=a),'Metadata failure erased verified data';
   r:=get_visible_ad_catalog(ARRAY[p],now()-interval '1 day',clock_timestamp());
   ASSERT jsonb_array_length(r)=1 AND (r->0->>'referral_contacts')::int=0,'Zero-lead ad disappeared or received invented referrals';
   ASSERT (get_ad_lead_quality(p,NULL,clock_timestamp())->>'inquiries')::int=0,'Inventory import invented a lead';
   ASSERT (SELECT count(*)=0 FROM contacts WHERE page_id=p),'Metadata created contacts';
   ASSERT NOT has_function_privilege('authenticated','public.save_ad_catalog_metadata(jsonb)','EXECUTE'),'Client can bypass Page authorization';
   ASSERT NOT has_function_privilege('anon','public.get_visible_ad_catalog(uuid[],timestamp with time zone,timestamp with time zone)','EXECUTE'),'Anonymous inventory access';
  END $$;`);
  await db.query('ROLLBACK');console.log(JSON.stringify({preflight:true,invariants:6,fixtures_rolled_back:true,messages_sent:0}));
 }
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({error:e.message}));process.exitCode=1;}finally{await db.end();}
