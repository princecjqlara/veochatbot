import fs from'node:fs';import pg from'pg';import{createRequire}from'node:module';
const{parse}=createRequire(import.meta.url)('../../node_modules/dotenv'),env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),apply=process.argv.includes('--apply');
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000}),sql=fs.readFileSync(new URL('../supabase/migrations/202610280003_preserve_same_message_ad_origin.sql',import.meta.url),'utf8');
try{await db.connect();if(apply){const before=Number((await db.query('SELECT count(*) FROM ad_contact_sources WHERE origin_ad_id IS NOT NULL')).rows[0].count);await db.query(sql);const after=Number((await db.query('SELECT count(*) FROM ad_contact_sources WHERE origin_ad_id IS NOT NULL')).rows[0].count);console.log(JSON.stringify({applied:true,origins_before:before,origins_after:after,repair_basis:'Identical first message ID, complete history and a unique recorded ad referral',customer_messages_sent:0}));}
 else{await db.query('BEGIN');await db.query(sql.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,''));await db.query(`DO $$ DECLARE p UUID:=gen_random_uuid();c UUID:=gen_random_uuid();first_at TIMESTAMPTZ:=date_trunc('second',now()-interval '2 hours');payload JSONB; BEGIN
 INSERT INTO pages(id,fb_page_id,name,access_token) VALUES(p,'verify-origin-id-'||p,'Origin identity fixture','not-a-token');
 INSERT INTO contacts(id,page_id,psid,name) VALUES(c,p,'fixture-contact','Fixture');
 INSERT INTO ad_contact_sources(contact_id,page_id,first_inquiry_at,first_message_id,inquiry_basis,origin_ad_id,origin_evidence_key,attribution_status) VALUES(c,p,first_at+interval '356 milliseconds','message-first','live_message','123','proof','verified_inline');
 payload:=jsonb_build_object('first_inquiry_at',first_at,'first_message_id','message-first','source_cutoff_at',now()-interval '1 hour','snapshots','[]'::jsonb);
 PERFORM save_contact_conversion_cache(p,c,payload);
 ASSERT(SELECT origin_ad_id='123' AND first_inquiry_at=first_at FROM ad_contact_sources WHERE contact_id=c),'Second precision erased the same-message origin';
 UPDATE ad_contact_sources SET first_inquiry_at=first_at+interval '500 milliseconds',inquiry_basis='live_message' WHERE contact_id=c;
 PERFORM save_contact_conversion_cache(p,c,payload||jsonb_build_object('first_message_id','ambiguous-same-second','source_cutoff_at',now()-interval '50 minutes'));
 ASSERT(SELECT origin_ad_id='123' AND first_message_id='message-first' FROM ad_contact_sources WHERE contact_id=c),'Coarse same-second ordering overrode actual message evidence';
 PERFORM save_contact_conversion_cache(p,c,payload||jsonb_build_object('first_inquiry_at',first_at-interval '1 day','first_message_id','genuinely-earlier','source_cutoff_at',now()-interval '40 minutes'));
 ASSERT(SELECT origin_ad_id IS NULL AND first_message_id='genuinely-earlier' FROM ad_contact_sources WHERE contact_id=c),'A returning contact retained a new-acquisition origin';
 UPDATE ad_contact_sources SET origin_ad_id='456',origin_evidence_key='new-proof',attribution_status='verified_inline' WHERE contact_id=c;
 PERFORM save_contact_conversion_cache(p,c,payload||jsonb_build_object('first_inquiry_at',first_at-interval '2 days','first_message_id','stale-older','source_cutoff_at',now()-interval '90 minutes'));
 ASSERT(SELECT origin_ad_id='456' AND first_message_id='genuinely-earlier' FROM ad_contact_sources WHERE contact_id=c),'Stale concurrent refresh changed a newer origin';
 END $$;`);await db.query('ROLLBACK');console.log(JSON.stringify({preflight:true,invariants:4,fixtures_rolled_back:true,customer_messages_sent:0}));}
}catch(e){await db.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({error:e.message}));process.exitCode=1;}finally{await db.end();}
