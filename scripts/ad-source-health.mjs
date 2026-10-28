import fs from 'node:fs';
import {createRequire} from 'node:module';
import pg from 'pg';
const {parse}=createRequire(import.meta.url)('../../node_modules/dotenv'),env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url)));
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
await db.connect();
try{
 await db.query('BEGIN READ ONLY');
 const activation=JSON.parse(fs.readFileSync(new URL('../../data/ad-source-subscriptions-activation-2026-10-27.json',import.meta.url)));
 const tracking=(await db.query('SELECT started_at FROM ad_tracking_settings WHERE singleton')).rows[0];
 const counts=(await db.query(`SELECT (SELECT count(*) FROM ad_contact_sources WHERE inquiry_basis LIKE 'live_%') AS live_inquiries,
 (SELECT count(*) FROM ad_contact_sources WHERE origin_ad_id IS NOT NULL) AS verified_ad_origins,
 (SELECT count(*) FROM ad_referral_events) AS referral_events,
 (SELECT count(*) FROM ad_referral_events WHERE ad_id IS NOT NULL) AS ad_referral_events,
 (SELECT count(*) FROM ad_source_catalog) AS known_ads,
 (SELECT max(received_at) FROM ad_referral_events) AS last_referral_received,
 (SELECT count(*) FROM ad_lead_stage_events WHERE recorded_at>=$1) AS stage_events_since_activation`,[tracking?.started_at||activation.at])).rows[0];
 const receipt={checked_at:new Date().toISOString(),tracking_started_at:tracking?.started_at,subscription_status_checked_at:activation.at,subscription_status_is_last_saved_check:true,subscriptions_all_five_ready:activation.pages.length===5&&activation.pages.every(p=>p.ready),apps_ready:activation.apps.every(a=>a.ready),counts,
 actual_meta_ad_event_received:Number(counts.ad_referral_events)>0,actual_verified_first_inquiry_ad_received:Number(counts.verified_ad_origins)>0};
 await db.query('ROLLBACK');fs.writeFileSync(new URL('../../data/ad-source-live-health-2026-10-27.json',import.meta.url),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}finally{await db.query('ROLLBACK').catch(()=>{});await db.end();}
