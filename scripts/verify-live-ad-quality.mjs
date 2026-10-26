import fs from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
const require=createRequire(import.meta.url),{parse}=require('../../node_modules/dotenv'),{encode}=require('next-auth/jwt');
const env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),base='https://veochatbot.vercel.app';
const ids=['656646850875530','717828411409985','725843003947429','619355471260631','781078668411527'];
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const receipt={at:new Date().toISOString(),base,read_only_application_requests:true,checks:[],ranges:[]};
try{
 await db.connect();
 const owner=(await db.query('SELECT up.user_id,count(*) AS n FROM user_pages up JOIN pages p ON p.id=up.page_id WHERE p.fb_page_id=ANY($1::text[]) GROUP BY up.user_id ORDER BY n DESC LIMIT 1',[ids])).rows[0];
 assert(owner&&Number(owner.n)===5,'No single existing member covers all five Pages');
 const token=await encode({token:{id:owner.user_id,name:'Ad quality release verification'},secret:env.NEXTAUTH_SECRET,maxAge:600});
 const headers={Cookie:'__Secure-next-auth.session-token='+token};
 const get=async(path,h=headers)=>{const r=await fetch(base+path,{headers:h,cache:'no-store',signal:AbortSignal.timeout(45000)});return{status:r.status,body:await r.json()};};
 assert.equal((await get('/api/ad-quality?range=today',{})).status,401);receipt.checks.push('Unauthenticated report denied');
 const forbidden=await get('/api/ad-quality?range=all&pageId='+randomUUID());assert.equal(forbidden.status,403);receipt.checks.push('Unrelated Page denied');
 let all;
 for(const query of ['range=today','range=7','range=30','range=all','range=custom&from=2026-10-20&to=2026-10-21']){
  const result=await get('/api/ad-quality?'+query);assert.equal(result.status,200,'Report HTTP '+result.status);assert(Array.isArray(result.body.pages));
  let inquiries=0,nq=0;
  for(const p of result.body.pages){
   assert.equal(p.rows.reduce((s,r)=>s+Number(r.inquiries),0),Number(p.inquiries));assert.equal(p.rows.reduce((s,r)=>s+Number(r.not_qualified),0),Number(p.not_qualified));
   for(const r of p.rows){assert.equal(Number(r.qualified)+Number(r.not_qualified)+Number(r.order_created)+Number(r.crm_converted)+Number(r.opted_out)+Number(r.pending),Number(r.inquiries));assert(Math.abs(Number(r.not_qualified_rate)-Number(r.not_qualified)/Number(r.inquiries))<1e-12);}
   inquiries+=Number(p.inquiries);nq+=Number(p.not_qualified);
  }
  receipt.ranges.push({query,pages:result.body.pages.length,inquiries,not_qualified:nq});if(query==='range=all')all=result.body;
 }
 receipt.checks.push('Today, 7 days, 30 days, all time and custom ranges reconcile','Every stage category and NQ rate reconciles');
 const page=all.pages.find(p=>p.rows.some(r=>Number(r.not_qualified)>0)),ad=page.rows.find(r=>Number(r.not_qualified)>0);
 const q=new URLSearchParams({range:'all',pageId:page.page.id,stage:'not_qualified',...(ad.ad_id?{adId:ad.ad_id}:{unknown:'true'})});
 const drill=await get('/api/ad-quality/contacts?'+q);assert.equal(drill.status,200);assert.equal(drill.body.total,Number(ad.not_qualified));assert(drill.body.contacts.every(c=>c.pipeline_stage==='not_qualified'));receipt.checks.push('Not-qualified contact drilldown matches the ad row');
 const cross=await fetch(base+'/api/ad-quality/resolve',{method:'POST',headers:{...headers,Origin:'https://unrelated.example','Content-Type':'application/json'},body:JSON.stringify({pageId:page.page.id,adIds:[]})});assert.equal(cross.status,403);receipt.checks.push('Cross-origin metadata trigger denied');
 receipt.passed=true;
 // Optional browser verification gets only a short-lived in-memory cookie.
 if(process.argv.includes('--browser')){const {verifyBrowser}=await import('./verify-ad-quality-browser.mjs');receipt.browser=await verifyBrowser({base,cookie:token});}
}catch(e){receipt.passed=false;receipt.error=String(e.message).slice(0,500);process.exitCode=1;}
finally{await db.end();fs.writeFileSync(new URL('../../data/ad-quality-live-verification-2026-10-27.json',import.meta.url),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
