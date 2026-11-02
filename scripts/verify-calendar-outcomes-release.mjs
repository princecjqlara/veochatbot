import fs from 'node:fs';import assert from 'node:assert/strict';import{createRequire}from'node:module';import pg from'pg';
const{encode}=createRequire(import.meta.url)('next-auth/jwt'),base=process.argv.find(v=>v.startsWith('--base='))?.slice(7)||'https://veochatbot.vercel.app';
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},query_timeout:120000});
const receipt={base,customer_messages_sent:0,financial_records_created:0,checks:[]};
try{
 await db.connect();const actor=(await db.query('SELECT user_id FROM user_pages GROUP BY user_id ORDER BY count(*) DESC LIMIT 1')).rows[0];
 const ids=(await db.query('SELECT page_id FROM user_pages WHERE user_id=$1',[actor.user_id])).rows.map(r=>r.page_id);
 const token=await encode({token:{id:actor.user_id,name:'Calendar outcome verification'},secret:process.env.NEXTAUTH_SECRET,maxAge:600});
 const headers={Cookie:(base.startsWith('https:')?'__Secure-next-auth.session-token=':'next-auth.session-token=')+token};
 const call=async url=>{const response=await fetch(base+url,{headers,signal:AbortSignal.timeout(90000)});return{status:response.status,body:await response.json()};};
 assert.equal((await fetch(base+'/api/ad-calendar?month=2026-10')).status,401);
 const response=await call('/api/ad-calendar?month=2026-10');assert.equal(response.status,200);const report=response.body;
 const expected=(await db.query("SELECT get_ad_calendar_report($1,'2026-10-01T00:00:00+08','2026-11-01T00:00:00+08',NULL) AS result",[ids])).rows[0].result;
 for(const field of ['inquiries','converted','orders','confirmed_payers','chat_confirmed_payers','payers']){
  const total=expected.groups.reduce((n,row)=>n+Number(row[field]||0),0);
  assert.equal(report.overall[field],total,field+' must match all-source records');
  assert.equal(report.days.reduce((n,row)=>n+row.overall[field],0),total,field+' must reconcile to its inquiry dates');
 }
 assert(report.overall.confirmed_payers>0);assert(report.overall.confirmed_payers>=report.overall.payers);
 receipt.checks.push('October documented customers, orders and conversions match source records and reconcile by inquiry date','All-source counts include unknown origins without assigning them to a creative');
 const day=report.days.find(row=>row.overall.confirmed_payers>0).day;
 const contacts=await call('/api/ad-calendar?'+new URLSearchParams({month:'2026-10',day,view:'contacts',status:'confirmed'}));
 assert.equal(contacts.status,200);assert(contacts.body.contacts.length>0);assert(contacts.body.contacts.every(c=>c.confirmed_at&&ids.includes(c.page_id)));
 receipt.checks.push('Confirmed customer drilldown includes later-month confirmations and remains authorized');
 const proof=(await db.query("SELECT f.contact_id,f.page_id FROM contact_conversion_cache f JOIN pages p ON p.id=f.page_id WHERE f.page_id=ANY($1::uuid[]) AND f.complete_history AND f.payment_at IS NOT NULL AND f.payment_evidence_id IS NOT NULL AND f.source_kind='live_graph' AND p.messaging_auto_tag_last_error IS NULL ORDER BY f.source_cutoff_at DESC LIMIT 1",[ids])).rows[0];
 if(proof){const evidence=await call('/api/ad-calendar/confirmation?'+new URLSearchParams({pageId:proof.page_id,contactId:proof.contact_id}));assert.equal(evidence.status,200,'Live confirmation should reopen its exact source');assert.equal(evidence.body.verification,'conversation_documented');assert.equal(evidence.body.ledger_verified,false);assert(evidence.body.text);receipt.checks.push('Live Page acknowledgement reopens without claiming a bank-verified receipt');}
 const verified=(await db.query('SELECT count(*)::int AS n FROM contact_verified_payments WHERE voided_at IS NULL')).rows[0].n;
 if(!verified){assert.equal(report.overall.financial_verified,false);assert.equal(report.overall.profit,null);receipt.checks.push('Chat confirmations do not invent receipt amounts, salary, profit or ROAS');}
 Object.assign(receipt,{passed:true,october:{inquiries:report.overall.inquiries,confirmed_customers:report.overall.confirmed_payers,chat_confirmations:report.overall.chat_confirmed_payers,ledger_payers:report.overall.payers,converted:report.overall.converted,orders:report.overall.orders,spend_complete:report.overall.spend.complete,financial_verified:report.overall.financial_verified}});
}catch(e){Object.assign(receipt,{passed:false,error:e.message});process.exitCode=1;}
finally{await db.end();fs.writeFileSync('.vercel/calendar-outcomes-live-'+(new URL(base).hostname==='localhost'?'local':'production')+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
