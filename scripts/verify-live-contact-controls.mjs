// Release verification: no customer permission changes or outbound messages.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
const require=createRequire(import.meta.url),{parse}=require('../../node_modules/dotenv'),{encode}=require('next-auth/jwt');
const env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),base='https://veochatbot.vercel.app';
const fbIds=['656646850875530','717828411409985','725843003947429','619355471260631','781078668411527'];
const releasedVersion=JSON.parse(fs.readFileSync(new URL('../src/lib/conversion-runtime/model-v2.json',import.meta.url))).version,allowedVersions=new Set(['eddb1b3d6b59c75e',releasedVersion]);
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const receipt={at:new Date().toISOString(),base,customer_permissions_changed:0,messages_sent:0,checks:[],pages:[],refresh:null};
try{
 await db.connect();
 const owner=(await db.query('SELECT up.user_id,count(*) AS n FROM user_pages up JOIN pages p ON p.id=up.page_id WHERE p.fb_page_id=ANY($1::text[]) GROUP BY up.user_id ORDER BY n DESC LIMIT 1',[fbIds])).rows[0];
 assert.equal(Number(owner?.n),5);
 const pages=(await db.query('SELECT id,name,fb_page_id FROM pages WHERE fb_page_id=ANY($1::text[])',[fbIds])).rows;
 const token=await encode({token:{id:owner.user_id,name:'Contact controls release verification'},secret:env.NEXTAUTH_SECRET,maxAge:1800});
 const headers={Cookie:'__Secure-next-auth.session-token='+token};
 if(process.argv.includes('--browser-only')){
  const{verifyContactBrowser}=await import('./verify-contact-controls-browser.mjs');receipt.browser=await verifyContactBrowser({base,cookie:token});receipt.passed=true;
 }else{
 async function call(path,options={}){const r=await fetch(base+path,{...options,headers:{...headers,...options.headers},cache:'no-store',signal:AbortSignal.timeout(125000)});return{status:r.status,body:await r.json()};}
 const unauth=await fetch(base+'/api/pages/'+pages[0].id+'/contacts/'+randomUUID()+'/projection');assert.equal(unauth.status,401);
 receipt.checks.push('Unauthenticated projection denied');
 for(const page of pages){
  const actual=(await db.query('SELECT count(*)::int AS total,count(*) FILTER(WHERE chatbot_enabled)::int AS on_count,count(*) FILTER(WHERE NOT chatbot_enabled)::int AS off_count FROM contacts WHERE page_id=$1',[page.id])).rows[0];
  let contact;
  for(const filter of ['all','on','off']){
   const r=await call('/api/pages/'+page.id+'/contacts?includeControls=true&pageSize=5&bot='+filter);
   assert.equal(r.status,200,'Contacts endpoint failed');assert(Array.isArray(r.body.items));
   assert.equal(r.body.total,actual[filter==='all'?'total':filter+'_count']);
   for(const c of r.body.items){assert.equal(typeof c.bot_control?.enabled,'boolean');if(filter!=='all')assert.equal(c.chatbot_enabled,filter==='on');assert(c.conversion_projection?.model_version);contact??=c;}
   const ad=await call('/api/ad-quality/contacts?range=all&pageId='+page.id+'&bot='+filter);assert.equal(ad.status,200);
   assert(Array.isArray(ad.body.contacts));
   for(const c of ad.body.contacts){assert.equal(typeof c.bot_control?.enabled,'boolean');if(filter!=='all')assert.equal(c.bot_control.enabled,filter==='on');}
  }
  if(contact){
   const path='/api/pages/'+page.id+'/contacts/'+contact.id;
   const r=await call(path+'/projection');assert.equal(r.status,200);assert(allowedVersions.has(r.body.conversion_projection?.model_version));
   const cross=await call(path+'/bot',{method:'PATCH',headers:{Origin:'https://unrelated.example','Content-Type':'application/json'},body:'{"enabled":false}'});assert.equal(cross.status,403);
  }
  const absent=await call('/api/pages/'+page.id+'/contacts/'+randomUUID()+'/bot',{method:'PATCH',headers:{Origin:base,'Content-Type':'application/json'},body:'{"enabled":false}'});assert.equal(absent.status,404);
  receipt.pages.push({page:page.name,...actual});
  console.log('Verified live contact filters for '+page.name);
 }
 receipt.checks.push('All five Pages return authorized controls and the released model','All / ON / OFF counts match the database before pagination','Ad contact filters return matching permissions','Cross-origin changes and nonexistent-contact changes denied');
 // Only a complete Graph history read and derived forecast cache write.
 const recent=(await db.query("SELECT c.id,c.page_id FROM contacts c JOIN contact_conversion_cache f ON f.contact_id=c.id JOIN pages p ON p.id=c.page_id WHERE p.fb_page_id=ANY($1::text[]) AND f.first_inquiry_at>now()-interval '25 days' AND f.payment_at IS NULL AND c.pipeline_stage IS DISTINCT FROM 'converted' AND c.last_inbound_at>now()-interval '7 days' ORDER BY c.last_inbound_at DESC LIMIT 1",[fbIds])).rows[0];
 assert(recent,'No observed recent unpaid contact available for the source-refresh check');
 const refresh=await call('/api/pages/'+recent.page_id+'/contacts/'+recent.id+'/projection',{method:'POST',headers:{Origin:base}});
 assert.equal(refresh.status,200,'Verified history refresh did not complete: '+String(refresh.body.error||refresh.status));
 const projection=refresh.body.conversion_projection;assert(projection?.as_of);assert(Date.now()-Date.parse(projection.as_of)<180000);assert(projection.first_inquiry_at<=projection.as_of);
 assert.equal(projection.model_version,releasedVersion);assert.equal(projection.forecast_method,'conversation_survival_v2');assert(projection.backtest?.n>0);
 for(const score of Object.values(projection.scores||{}))assert(score.probability===null||score.probability>=0&&score.probability<=1);
 const cache=(await db.query('SELECT complete_history,source_kind FROM contact_conversion_cache WHERE contact_id=$1',[recent.id])).rows[0];assert.equal(cache.complete_history,true);assert.equal(cache.source_kind,'live_graph');
 const ledger=(await db.query('SELECT count(*)::int AS n FROM contact_conversion_prediction_issues WHERE contact_id=$1 AND model_version=$2',[recent.id,projection.model_version])).rows[0];assert(ledger.n>0);
 receipt.refresh={complete_history:true,source_kind:cache.source_kind,status:projection.status,model_version:projection.model_version,source_cutoff:projection.as_of,has_future_probability:Object.values(projection.scores||{}).some(s=>s.status==='estimated'),hourly_forecast_recorded:true};
 receipt.checks.push('Complete live Messenger history refresh and bounded probabilities','Versioned forecast issue recorded without customer messaging');
 if(process.argv.includes('--browser')){const{verifyContactBrowser}=await import('./verify-contact-controls-browser.mjs');receipt.browser=await verifyContactBrowser({base,cookie:token});}
 receipt.passed=true;
 }
}catch(e){receipt.passed=false;receipt.error=String(e.message).slice(0,500);process.exitCode=1;}
finally{await db.end();const name=process.argv.includes('--browser-only')?'contact-controls-browser-verification-2026-10-27.json':'contact-controls-api-verification-2026-10-27.json';fs.writeFileSync(new URL('../../data/'+name,import.meta.url),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
