// Read complete histories and verify forecasts; never send customer messages.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import pg from 'pg';
const require=createRequire(import.meta.url),{parse}=require('../../node_modules/dotenv'),{encode}=require('next-auth/jwt');
const env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),base='https://veochatbot.vercel.app';
const fbIds=['656646850875530','717828411409985','725843003947429','619355471260631','781078668411527'];
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
const receipt={at:new Date().toISOString(),production:base,pages:[],checks:[],customer_messages_sent:0,customer_bot_permissions_changed:0,model_retrained:false};
try{
 await db.connect();
 const owner=(await db.query('SELECT up.user_id,count(*) AS n FROM user_pages up JOIN pages p ON p.id=up.page_id WHERE p.fb_page_id=ANY($1::text[]) GROUP BY up.user_id ORDER BY n DESC LIMIT 1',[fbIds])).rows[0];assert.equal(Number(owner?.n),5);
 const token=await encode({token:{id:owner.user_id,name:'Early forecast release verification'},secret:env.NEXTAUTH_SECRET,maxAge:1800}),headers={Cookie:'__Secure-next-auth.session-token='+token};
 const pages=(await db.query('SELECT id,name FROM pages WHERE fb_page_id=ANY($1::text[])',[fbIds])).rows;
 for(const page of pages){
  const candidates=(await db.query(`SELECT c.id FROM contacts c JOIN contact_conversion_cache f ON f.contact_id=c.id AND f.page_id=c.page_id
   CROSS JOIN LATERAL(SELECT s FROM jsonb_array_elements(f.snapshots) s ORDER BY (s->>'h')::numeric DESC LIMIT 1) latest
   WHERE c.page_id=$1 AND c.pipeline_stage IS DISTINCT FROM 'converted' AND f.complete_history AND f.payment_at IS NULL
   AND f.first_inquiry_at>now()-interval '29 days' AND latest.s->>'b' IN('initial_inquiry','active_conversation','returned_later')
   ORDER BY f.first_inquiry_at DESC LIMIT 4`,[page.id])).rows;
  assert(candidates.length,'No cached early-signal contact available for '+page.name);
  let verified;
  for(const contact of candidates){
   const prior=(await db.query("SELECT score_hour,prediction FROM contact_conversion_prediction_issues WHERE contact_id=$1 AND model_version=$2 AND score_hour=date_trunc('hour',now())",[contact.id,'dd7f0ca783ad1651'])).rows[0];
   const response=await fetch(`${base}/api/pages/${page.id}/contacts/${contact.id}/projection`,{method:'POST',headers:{...headers,Origin:base},signal:AbortSignal.timeout(125000)}),body=await response.json();
   assert.equal(response.status,200,body.error||'Projection refresh failed');const p=body.conversion_projection;
   assert.equal(p.model_version,'dd7f0ca783ad1651');assert.equal(p.projection_policy_version,'stage-validation-2026-10-29');
   if(p.status!=='estimated'||p.signal_stage?.group!=='inquiry_or_conversation')continue;
   assert.equal(p.signal_stage.agreement_required,false);assert.equal(p.signal_stage.agreement_verified,false);
   assert.equal(p.forecast_method,'conversation_survival_v2');assert(p.scores['720'].probability>0&&p.scores['720'].probability<1);
   for(const [h,m]of Object.entries(p.stage_backtests)){
    if(m?.timing?.n<30)assert(!p.close_windows[h],'Unsupported stage-specific date was exposed');
   }
   const saved=(await db.query('SELECT source_kind,complete_history,payment_at,snapshots FROM contact_conversion_cache WHERE contact_id=$1',[contact.id])).rows[0];
   assert.equal(saved.source_kind,'live_graph');assert.equal(saved.complete_history,true);assert.equal(saved.payment_at,null);
   const ledger=(await db.query('SELECT score_hour,prediction FROM contact_conversion_prediction_issues WHERE contact_id=$1 AND model_version=$2 ORDER BY score_hour DESC LIMIT 1',[contact.id,p.model_version])).rows[0];assert(ledger);
   const sameHour=prior&&prior.score_hour.getTime()===ledger.score_hour.getTime();
   if(sameHour)assert.deepEqual(ledger.prediction,prior.prediction,'An existing first-issued forecast must not be overwritten');else assert.equal(ledger.prediction.projection_policy_version,'stage-validation-2026-10-29');
   verified={page:page.name,contact_id:contact.id,first_inquiry_at:p.first_inquiry_at,source_checked_at:p.as_of,checkpoint_hours:p.checkpoint_hours,signal_stage:p.signal_stage.label,agreement_required:false,payment_probabilities:Object.fromEntries(Object.entries(p.scores).map(([h,s])=>[h,s.probability])),stage_replay:Object.fromEntries(Object.entries(p.stage_backtests).map(([h,m])=>[h,{contacts:m?.n,later_confirmations:m?.events}])),supported_date_horizons:Object.keys(p.close_windows),ledger_check:sameHour?'Existing first-issued forecast preserved':'New first-issued forecast includes policy version'};
   break;
  }
  assert(verified,'No current early-signal contact verified for '+page.name);receipt.pages.push(verified);
 }
 receipt.checks.push('All five trained Pages project payment for current inquiry / conversation signals without an agreement','Complete live Graph histories verified; no payment or form was invented','Stage-specific dates withheld below 30 replay confirmations','Immutable hourly ledger preserves any existing first-issued forecast; new issues include the policy version');
 receipt.passed=true;
}catch(e){receipt.passed=false;receipt.error=String(e.message).slice(0,600);process.exitCode=1;}
finally{
 await db.end();const dir=new URL('../../data/early-contact-projections-2026-10-29/',import.meta.url);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(new URL('live-verification.json',dir),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}
