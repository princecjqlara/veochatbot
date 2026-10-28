import fs from'node:fs';import assert from'node:assert/strict';import{createRequire}from'node:module';import{randomUUID}from'node:crypto';import pg from'pg';
const require=createRequire(import.meta.url),{parse}=require('../../node_modules/dotenv'),{encode}=require('next-auth/jwt'),env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),base='https://veochatbot.vercel.app';
const ids=['656646850875530','717828411409985','725843003947429','619355471260631','781078668411527'],db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const receipt={at:new Date().toISOString(),production:base,checks:[],ads:[],ranges:[],messages_sent:0,manual_contact_ad_assignments:0,campaign_budgets_changed:0,history_note:'Opening contact forecasts can reconcile earlier verified inquiry dates and clear an unsupported original ad; metadata import itself never assigns contact origins.'};
try{
 await db.connect();const owner=(await db.query('SELECT up.user_id,count(*) AS n FROM user_pages up JOIN pages p ON p.id=up.page_id WHERE p.fb_page_id=ANY($1::text[]) GROUP BY up.user_id ORDER BY n DESC LIMIT 1',[ids])).rows[0];assert.equal(Number(owner.n),5);
 const token=await encode({token:{id:owner.user_id,name:'Ad visibility release verification'},secret:env.NEXTAUTH_SECRET,maxAge:1200}),headers={Cookie:'__Secure-next-auth.session-token='+token};
 const call=async(path,options={})=>{const r=await fetch(base+path,{...options,headers:{...headers,...options.headers},cache:'no-store',signal:AbortSignal.timeout(125000)});return{status:r.status,body:await r.json()};};
 const missing=await fetch(base+'/api/ad-quality/connection');assert.equal(missing.status,401);
 const connection=await call('/api/ad-quality/connection');assert.equal(connection.status,200);assert.equal(connection.body.status,'connect_required');receipt.checks.push('Authenticated connection status is explicit; no user-token access is invented');
 const postHeaders={Origin:base,'Content-Type':'application/json'},denied=await call('/api/ad-quality/sync',{method:'POST',headers:postHeaders,body:JSON.stringify({accountId:'act_123',pageId:randomUUID()})});assert.equal(denied.status,403);
 const needToken=await call('/api/ad-quality/sync',{method:'POST',headers:postHeaders,body:JSON.stringify({accountId:'act_123'})});assert.equal(needToken.status,409);receipt.checks.push('Unrelated Page imports denied; real Facebook token required for account import');
 const pages=(await db.query('SELECT id,name FROM pages WHERE fb_page_id=ANY($1::text[])',[ids])).rows;
 for(const page of pages){const ads=(await db.query('SELECT ad_id FROM ad_source_catalog WHERE page_id=$1',[page.id])).rows;if(!ads.length)continue;
  const resolved=await call('/api/ad-quality/resolve',{method:'POST',headers:postHeaders,body:JSON.stringify({pageId:page.id,adIds:ads.map(a=>a.ad_id)})});assert.equal(resolved.status,200);assert(resolved.body.results.every(a=>a.resolved));
 }
 const catalog=(await db.query('SELECT a.ad_id,a.photo_url,a.video_url,a.metadata_status,p.name AS page FROM ad_source_catalog a JOIN pages p ON p.id=a.page_id WHERE p.fb_page_id=ANY($1::text[])',[ids])).rows;assert(catalog.length>=6);
 for(const ad of catalog){assert(ad.photo_url);assert(ad.video_url);const r=await fetch(ad.photo_url,{signal:AbortSignal.timeout(12000)});await r.body?.cancel();assert(r.ok,'Facebook poster could not be read');receipt.ads.push({page:ad.page,ad_id:ad.ad_id,poster_accessible:true,has_video:true,metadata_source:ad.metadata_status});}
 receipt.checks.push('All captured ads have genuine accessible Page-post thumbnails and recorded video sources');
 for(const query of ['range=today','range=7','range=30','range=all','range=custom&from=2026-10-20&to=2026-10-21']){
  const r=await call('/api/ad-quality?'+query);assert.equal(r.status,200);let visible=0,inquiries=0;
  for(const p of r.body.pages){assert.equal(p.rows.reduce((s,a)=>s+Number(a.inquiries),0),Number(p.inquiries));for(const a of p.tracked_ads){assert.equal(a.page_id,p.page.id);visible++;}inquiries+=Number(p.inquiries);}
  assert(visible>=catalog.length);receipt.ranges.push({query,visible_catalog_ads:visible,first_inquiry_cohort:inquiries});
 }
 receipt.checks.push('Today / 7 / 30 / all / custom retain catalog ads while cohort totals reconcile');
 if(process.argv.includes('--browser')){const{verifyBrowser}=await import('./verify-ad-quality-browser.mjs');receipt.browser=await verifyBrowser({base,cookie:token});}
 receipt.passed=true;
}catch(e){receipt.passed=false;receipt.error=String(e.message).slice(0,500);process.exitCode=1;}
finally{await db.end();fs.writeFileSync(new URL('../../data/ad-visibility-2026-10-28/live-verification.json',import.meta.url),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
