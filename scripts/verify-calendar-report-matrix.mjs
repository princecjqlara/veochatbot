import fs from'node:fs';import assert from'node:assert/strict';import pg from'pg';import{createRequire}from'node:module';
const{encode}=createRequire(import.meta.url)('next-auth/jwt'),base=process.argv.find(v=>v.startsWith('--base='))?.slice(7)||'https://veochatbot.vercel.app';
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},query_timeout:120000});
const receipt={base,checks:[],financial_records_created:0,customer_messages_sent:0,results:[]};
const flush=()=>fs.writeFileSync('.vercel/calendar-report-matrix-'+(new URL(base).hostname==='localhost'?'local':'production')+'.json',JSON.stringify(receipt,null,2));
try{
 await db.connect();const actor=(await db.query('SELECT user_id FROM user_pages GROUP BY user_id ORDER BY count(*) DESC LIMIT 1')).rows[0];
 const ids=(await db.query('SELECT page_id FROM user_pages WHERE user_id=$1',[actor.user_id])).rows.map(r=>r.page_id);
 const months=(await db.query("SELECT to_char(at AT TIME ZONE 'Asia/Manila','YYYY-MM') AS month,count(*)::int AS inquiries FROM (SELECT s.first_inquiry_at AS at FROM ad_contact_sources s WHERE s.page_id=ANY($1::uuid[]) UNION ALL SELECT c.first_interaction_at FROM contacts c WHERE c.page_id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM ad_contact_sources s WHERE s.contact_id=c.id AND s.page_id=c.page_id)) dates WHERE at IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC",[ids])).rows;
 const cookie=await encode({token:{id:actor.user_id,name:'Calendar report matrix verification'},secret:process.env.NEXTAUTH_SECRET,maxAge:1800});
 const headers={Cookie:(base.startsWith('https:')?'__Secure-next-auth.session-token=':'next-auth.session-token=')+cookie};
 const call=async(params,label)=>{
  const start=Date.now(),response=await fetch(base+'/api/ad-calendar?'+params,{headers,signal:AbortSignal.timeout(110000)}),body=await response.json();
  receipt.results.push({case:label,status:response.status,ms:Date.now()-start,error:body.error,inquiries:body.overall?.inquiries});flush();
  assert.equal(response.status,200,label+': '+body.error);
  if(body.days){
   for(const field of ['inquiries','confirmed_payers','converted','orders','payers'])assert.equal(body.days.reduce((sum,day)=>sum+day.overall[field],0),body.overall[field],label+' / '+field);
   assert(body.overall.confirmed_payers<=body.overall.inquiries);
  }
  return body;
 };
 for(const month of [...new Set([...months.map(row=>row.month),'2000-01','2099-12'])])await call(new URLSearchParams({month}),month+' / all Pages');
 receipt.checks.push('Every recorded inquiry month loads and its daily totals reconcile, plus empty and future months');
 const month=months[0].month;
 await call(new URLSearchParams({month,adId:''}),'empty ad selection');await call(new URLSearchParams({month,adId:' '}),'blank ad selection');await call(new URLSearchParams({month,adId:'unknown'}),'unknown sources');
 const pages=(await db.query('SELECT page_id,count(*) AS n FROM contacts WHERE page_id=ANY($1::uuid[]) GROUP BY 1 ORDER BY count(*) DESC LIMIT 3',[ids])).rows;
 for(const page of pages)await call(new URLSearchParams({month,pageId:page.page_id}),'single Page '+page.page_id);
 const ads=(await db.query('SELECT ad_id,page_id FROM ad_source_catalog WHERE page_id=ANY($1::uuid[]) ORDER BY ad_id LIMIT 3',[ids])).rows;
 for(const ad of ads)await call(new URLSearchParams({month,pageId:ad.page_id,adId:ad.ad_id}),'creative '+ad.ad_id);
 const report=await call(new URLSearchParams({month}),'drilldown month'),day=report.days.find(row=>row.overall.inquiries>0)?.day||report.selected_day;
 for(const status of ['all','confirmed','converted','orders','paid','unconverted']){
  const result=await call(new URLSearchParams({month,day,view:'contacts',status}),'contact status '+status);
  assert(result.total>=result.contacts.length);assert(result.contacts.every(contact=>ids.includes(contact.page_id)&&contact.name!==undefined));
 }
 const options=await call(new URLSearchParams({view:'pages'}),'independent Page options');assert.equal(options.pages.length,ids.length);
 receipt.checks.push('Empty/unknown/creative filters, largest Page scopes, six contact filters and independent Page options work');
 receipt.recorded_months=months.length;receipt.passed=true;
}catch(e){receipt.passed=false;receipt.error=e.message;process.exitCode=1;}
finally{await db.end();flush();console.log(JSON.stringify({passed:receipt.passed,recorded_months:receipt.recorded_months,cases:receipt.results.length,error:receipt.error,slowest:receipt.results.slice().sort((a,b)=>b.ms-a.ms).slice(0,5),checks:receipt.checks},null,2));}
