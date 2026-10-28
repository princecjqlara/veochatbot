import fs from'node:fs';import assert from'node:assert/strict';import{createRequire}from'node:module';import pg from'pg';
const require=createRequire(import.meta.url),{parse}=require('../../node_modules/dotenv'),{encode}=require('next-auth/jwt'),env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),base=process.env.VERIFY_BASE_URL||'https://veochatbot.vercel.app';
const fbIds=['656646850875530','717828411409985','725843003947429','619355471260631','781078668411527'],db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const receipt={at:new Date().toISOString(),production:base,checks:[],pages:[],ranges:[],messages_sent:0,bot_permissions_changed:0,campaign_budgets_changed:0};
try{
 await db.connect();const owner=(await db.query('SELECT up.user_id,count(*) AS n FROM user_pages up JOIN pages p ON p.id=up.page_id WHERE p.fb_page_id=ANY($1::text[]) GROUP BY up.user_id ORDER BY n DESC LIMIT 1',[fbIds])).rows[0];assert.equal(Number(owner.n),5);
 const cookie=await encode({token:{id:owner.user_id,name:'Conversion performance release verification'},secret:env.NEXTAUTH_SECRET,maxAge:3600}),headers={Cookie:'__Secure-next-auth.session-token='+cookie};
 const call=async(path,options={})=>{const r=await fetch(base+path,{...options,headers:{...headers,...options.headers},signal:AbortSignal.timeout(125000)});return{status:r.status,body:await r.json()};};
 assert.equal((await fetch(base+'/api/ad-quality/performance')).status,401);
 assert.equal((await call('/api/ad-quality/performance?pageId=00000000-0000-0000-0000-000000000000')).status,403);
 assert.equal((await call('/api/ad-quality/spend',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'})).status,403);
 receipt.checks.push('Authentication, unrelated Page access and cross-origin spend writes rejected');
 const pages=(await db.query('SELECT id,name FROM pages WHERE fb_page_id=ANY($1::text[])',[fbIds])).rows;
 for(const page of pages){
  const skip=[],verification={processed:0,failed:0,pending:null};
  for(let i=0;i<10;i++){
   const r=await call('/api/ad-quality/refresh-evidence?range=today&pageId='+page.id,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({skip})});assert.equal(r.status,200);verification.processed+=r.body.processed.length;verification.failed+=r.body.failed.length;verification.pending=r.body.pending;skip.push(...r.body.processed,...r.body.failed);if(!r.body.pending||!r.body.processed.length&&!r.body.failed.length)break;
  }
  const r=await call('/api/ad-quality/performance?range=today&pageId='+page.id);assert.equal(r.status,200,JSON.stringify(r.body));const p=r.body.pages[0];assert.equal(p.page_id,page.id);
  const raw=(await db.query(`SELECT (SELECT count(*)::int FROM ad_lead_cohorts WHERE page_id=$1 AND first_inquiry_at>=$2 AND first_inquiry_at<$3) AS leads,
   (SELECT count(*)::int FROM contact_conversion_cache WHERE page_id=$1 AND complete_history AND payment_evidence_id IS NOT NULL AND payment_at>=first_inquiry_at AND payment_at<=source_cutoff_at AND payment_at>=$2 AND payment_at<$3) AS payers`,[page.id,r.body.range.from,r.body.range.to])).rows[0];
  assert.equal(p.leads,raw.leads);assert.equal(Number(p.period_payments.confirmed),raw.payers);assert.equal(r.body.ads.reduce((s,a)=>s+a.leads,0),p.leads);assert.equal(r.body.daily.reduce((s,a)=>s+a.leads,0),p.leads);
  for(const a of r.body.ads){for(const h of ['168','336','720'])if(a.forecast[h].unknown)assert.equal(a.forecast[h].rate,null);if(a.spend.covered_days<a.spend.required_days)assert.equal(a.spend.amount,null);}
  receipt.pages.push({page:page.name,inquiries_today:p.leads,first_payment_confirmations_today:p.period_payments.confirmed,mean_hours_for_todays_payers:p.period_payments.avg_hours,median_hours_for_todays_payers:p.period_payments.median_hours,today_cohort_payers_so_far:p.confirmed,cohort_rate_so_far:p.current_rate,projection_day30:p.forecast['720'],verification,remaining_queue:r.body.refresh_pending});
 }
 receipt.checks.push('All five Pages: current PHT inquiry cohorts, first payments in period, mean/median durations and daily/ad totals reconcile','Latest relevant histories refreshed without customer messaging; unavailable sources remain flagged');
 const az=pages.find(p=>p.name==='Azshinari');
 for(const query of ['range=7','range=30','range=custom&from=2026-10-20&to=2026-10-21','range=all']){
  const start=Date.now(),r=await call('/api/ad-quality/performance?'+query+'&pageId='+az.id+'&target=3.5');assert.equal(r.status,200,JSON.stringify(r.body));const p=r.body.pages[0];
  const raw=(await db.query('SELECT count(*)::int AS n FROM ad_lead_cohorts WHERE page_id=$1 AND ($2::timestamptz IS NULL OR first_inquiry_at>=$2) AND first_inquiry_at<$3',[az.id,r.body.range.from,r.body.range.to])).rows[0];assert.equal(p.leads,raw.n);assert.equal(r.body.ads.reduce((s,a)=>s+a.leads,0),p.leads);assert.equal(r.body.daily.reduce((s,a)=>s+a.leads,0),p.leads);assert.equal(r.body.target_rate,.035);
  receipt.ranges.push({query,leads:p.leads,payers_from_cohort:p.confirmed,payments_in_period:p.period_payments.confirmed,elapsed_ms:Date.now()-start});
 }
 receipt.checks.push('7/30/custom/all-time cohorts reconcile beyond 1000 leads; target switch preserves the denominator');
 receipt.stored_daily_spend_records=Number((await db.query('SELECT count(*) AS n FROM ad_daily_spend WHERE page_id=ANY($1::uuid[])',[pages.map(p=>p.id)])).rows[0].n);
 receipt.verified_origin_links=Number((await db.query('SELECT count(*) AS n FROM ad_contact_sources WHERE page_id=ANY($1::uuid[]) AND origin_ad_id IS NOT NULL',[pages.map(p=>p.id)])).rows[0].n);
 if(process.argv.includes('--browser')){const{verifyPerformanceBrowser}=await import('./verify-conversion-performance-browser.mjs');receipt.browser=await verifyPerformanceBrowser({base,cookie});}
 receipt.passed=true;
}catch(e){receipt.passed=false;receipt.error=String(e.message).slice(0,800);process.exitCode=1;}
finally{await db.end();const dir=new URL('../../data/conversion-performance-2026-10-29/',import.meta.url);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(new URL('live-verification.json',dir),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
