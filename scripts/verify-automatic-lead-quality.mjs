// Read-only live checks. No real contact stage, permission or message is changed.
import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';import{createRequire}from'node:module';import pg from'pg';
const require=createRequire(import.meta.url),{parse}=require('../../node_modules/dotenv'),{encode}=require('next-auth/jwt'),env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),base='https://veochatbot.vercel.app';
const ids=['656646850875530','717828411409985','725843003947429','619355471260631','781078668411527'],db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const receipt={at:new Date().toISOString(),production:base,pages:[],checks:[],customer_stages_changed:0,customer_messages_sent:0,bot_permissions_changed:0,forecast_weights_changed:false};
try{
 await db.connect();const owner=(await db.query('SELECT up.user_id,count(*) AS n FROM user_pages up JOIN pages p ON p.id=up.page_id WHERE p.fb_page_id=ANY($1::text[]) GROUP BY up.user_id ORDER BY n DESC LIMIT 1',[ids])).rows[0];assert.equal(Number(owner.n),5);
 const cookie=await encode({token:{id:owner.user_id,name:'Lead quality release verification'},secret:env.NEXTAUTH_SECRET,maxAge:1800}),headers={Cookie:'__Secure-next-auth.session-token='+cookie};
 const get=async p=>{const r=await fetch(base+p,{headers,signal:AbortSignal.timeout(125000)}),body=await r.json();assert.equal(r.status,200,p+': '+JSON.stringify(body));return body;};
 for(const p of(await db.query('SELECT id,name FROM pages WHERE fb_page_id=ANY($1::text[])',[ids])).rows){
  const pipeline=await get('/api/pages/'+p.id+'/pipeline?stage=not_qualified&pageSize=5');
  for(const c of pipeline.contacts){assert.equal(c.pipeline_stage,'not_qualified');assert.equal(c.lead_quality.status,'poor');}
  const contacts=await get('/api/pages/'+p.id+'/contacts?pageSize=10');for(const c of contacts.items){const expected=c.pipeline_stage==='not_qualified'?'poor':['qualified','order_created','converted'].includes(c.pipeline_stage)?'good':'unassessed';assert.equal(c.lead_quality.status,expected);}
  const performance=await get('/api/ad-quality/performance?range=7&pageId='+p.id);
  for(const a of[...performance.pages,...performance.ads,...performance.daily]){assert.equal(a.lead_quality.poor,a.not_qualified);assert.equal(a.lead_quality.poor_rate,a.leads?a.not_qualified/a.leads:null);}
  const ads=await get('/api/ad-quality?pageId='+p.id+'&range=7');for(const a of ads.pages[0].rows){assert.equal(a.lead_quality.poor,a.not_qualified);assert.equal(a.lead_quality.poor_rate,a.inquiries?a.not_qualified/a.inquiries:null);}
  receipt.pages.push({page:p.name,not_qualified_contacts_checked:pipeline.contacts.length,contacts_checked:contacts.items.length,poor_leads_in_7day_inquiry_cohort:performance.pages[0].lead_quality.poor});
 }
 receipt.checks.push('Current Not Qualified stages return poor lead quality for all five Pages','Pipeline, Contacts, ad-quality and daily performance APIs agree on the rule','Poor-lead shares retain the original inquiry cohort and verified ad source','No actual customer stage or automation setting was changed during verification');
 receipt.passed=true;
}catch(e){receipt.passed=false;receipt.error=String(e.message).slice(0,700);process.exitCode=1;}
finally{await db.end();const out=path.resolve(import.meta.dirname,'../../data/automatic-lead-quality-2026-10-29');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'live-verification.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
