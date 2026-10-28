// Read-only diagnostics. Never log tokens or raw customer messages.
import fs from'node:fs';import{createRequire}from'node:module';import pg from'pg';
const{parse}=createRequire(import.meta.url)('../../node_modules/dotenv'),env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),partner=parse(fs.readFileSync(new URL('../../tokkodev/.env.local',import.meta.url)));
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const ids=['656646850875530','717828411409985','725843003947429','619355471260631','781078668411527'];
const report={at:new Date().toISOString(),read_only:true,pages:[],ads:[],referral_shapes:[]};
async function graph(path,token){const r=await fetch('https://graph.facebook.com/v24.0/'+path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)}),b=await r.json();return{ok:r.ok&&!b.error,body:b};}
try{
 await db.connect();const pages=(await db.query('SELECT id,name,fb_page_id,access_token FROM pages WHERE fb_page_id=ANY($1::text[])',[ids])).rows;
 report.ads=(await db.query(`SELECT p.name AS page,a.ad_id,a.ad_name,a.ad_title,a.post_id,a.creative_id,a.campaign_name,a.metadata_source,a.metadata_checked_at,
 a.photo_url IS NOT NULL AS has_photo,a.video_url IS NOT NULL AS has_video,
 (SELECT count(*)::int FROM ad_contact_sources s WHERE s.page_id=a.page_id AND s.origin_ad_id=a.ad_id) AS first_origins,
 (SELECT count(*)::int FROM ad_referral_events r WHERE r.page_id=a.page_id AND r.ad_id=a.ad_id) AS referral_events
 FROM ad_source_catalog a JOIN pages p ON p.id=a.page_id ORDER BY p.name,a.ad_id`)).rows;
 report.referral_shapes=(await db.query("SELECT array(SELECT jsonb_object_keys(referral)) AS fields,count(*)::int FROM ad_referral_events GROUP BY 1")).rows;
 for(const p of pages){
  const row={page:p.name,permissions:null,ad_node:null};
  try{const app='1350694239880908',secret=partner.FACEBOOK_APP_SECRET||partner.FACEBOOK_CLIENT_SECRET;const debug=await graph('debug_token?input_token='+encodeURIComponent(p.access_token),app+'|'+secret);row.permissions=debug.ok?{valid:debug.body.data?.is_valid,app_id:debug.body.data?.app_id,scopes:debug.body.data?.scopes}: {error_code:debug.body.error?.code};}catch{row.permissions={unavailable:true};}
  const ad=report.ads.find(a=>a.page===p.name);
  if(ad){try{const result=await graph(ad.ad_id+'?fields=id,name,creative{id,thumbnail_url,effective_object_story_id}',p.access_token);row.ad_node=result.ok?{accessible:true,name:result.body.name,has_creative:!!result.body.creative}: {accessible:false,error_code:result.body.error?.code,message:String(result.body.error?.message||'').replaceAll(p.access_token,'[redacted]').slice(0,300)};}catch{row.ad_node={unavailable:true};}}
  report.pages.push(row);
 }
}finally{await db.end();fs.mkdirSync(new URL('../../data/ad-visibility-2026-10-28/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../../data/ad-visibility-2026-10-28/audit.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
