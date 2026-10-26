import fs from 'node:fs';
import {createRequire} from 'node:module';
import pg from 'pg';
const {parse}=createRequire(import.meta.url)('../../node_modules/dotenv');
const env=parse(fs.readFileSync(new URL('../.env.local',import.meta.url))),partner=parse(fs.readFileSync(new URL('../../tokkodev/.env.local',import.meta.url)));
const apply=process.argv.includes('--apply'),base='https://veochatbot.vercel.app',required=['messages','messaging_postbacks','message_echoes','messaging_referrals'];
const ids=['656646850875530','717828411409985','725843003947429','619355471260631','781078668411527'];
const configs=[{id:env.FACEBOOK_CLIENT_ID,secret:env.FACEBOOK_CLIENT_SECRET,path:'/api/facebook/webhook'},
 {id:'1350694239880908',secret:partner.FACEBOOK_APP_SECRET||partner.FACEBOOK_CLIENT_SECRET,path:'/api/facebook/partner-webhook'}];
async function graph(path,token,options={}){
 const r=await fetch('https://graph.facebook.com/v24.0/'+path,{...options,headers:{Authorization:'Bearer '+token,...options.headers},signal:AbortSignal.timeout(12000)});const b=await r.json();
 if(!r.ok||b.error){const e=new Error('Meta rejected request');e.code=b.error?.code||r.status;e.subcode=b.error?.error_subcode;throw e;}return b;
}
const report={at:new Date().toISOString(),apply,apps:[],pages:[],customer_messages_sent:0};
const db=new pg.Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000});
try{
 for(const app of configs){
  try{
   if(!app.id||!app.secret)throw Object.assign(new Error('Missing configured app credentials'),{code:'MISSING_APP_CREDENTIALS'});
   const token=app.id+'|'+app.secret,read=async()=>(await graph(app.id+'/subscriptions',token)).data?.find(s=>s.object==='page');
   let sub=await read();if(!sub?.active||sub.callback_url!==base+app.path)throw Object.assign(new Error('Unexpected callback'),{code:'UNEXPECTED_CALLBACK'});
   const before=(sub.fields||[]).map(f=>typeof f==='string'?f:f.name),wanted=[...new Set([...before,...required])];
   if(apply&&wanted.some(f=>!before.includes(f))){
    // Verify our existing callback with the local configured token before changing fields.
    const u=new URL(sub.callback_url);u.searchParams.set('hub.mode','subscribe');u.searchParams.set('hub.verify_token',env.FACEBOOK_WEBHOOK_VERIFY_TOKEN);u.searchParams.set('hub.challenge','ad-source-subscription-check');
    const check=await fetch(u,{signal:AbortSignal.timeout(15000)});
    if(!check.ok||await check.text()!=='ad-source-subscription-check')throw Object.assign(new Error('Callback verification unavailable'),{code:'CALLBACK_VERIFICATION_FAILED'});
    await graph(app.id+'/subscriptions',token,{method:'POST',body:new URLSearchParams({object:'page',callback_url:sub.callback_url,verify_token:env.FACEBOOK_WEBHOOK_VERIFY_TOKEN,fields:wanted.join(','),include_values:'true'})});sub=await read();
   }
   const after=(sub.fields||[]).map(f=>typeof f==='string'?f:f.name);
   report.apps.push({app_id:app.id,callback:sub.callback_url,before,after,ready:required.every(f=>after.includes(f))});
  }catch(e){report.apps.push({app_id:app.id,error_code:e.code||'APP_SUBSCRIPTION_CHECK_FAILED',error_subcode:e.subcode||null});}
 }
 await db.connect();
 const pages=(await db.query('SELECT id,name,fb_page_id,access_token FROM pages WHERE fb_page_id=ANY($1::text[])',[ids])).rows;
 for(const page of pages){
  try{
   const read=async()=>(await graph(page.fb_page_id+'/subscribed_apps',page.access_token)).data||[];
   const before=await read(),recognized=before.filter(a=>configs.some(c=>c.id===a.id));
   if(recognized.length!==1)throw Object.assign(new Error('Ambiguous Page routing'),{code:'UNEXPECTED_PAGE_ROUTING'});
   const current=recognized[0],fields=[...new Set([...(current.subscribed_fields||[]),...required])];
   if(apply&&fields.some(f=>!current.subscribed_fields.includes(f))){
    const saved=await graph(page.fb_page_id+'/subscribed_apps',page.access_token,{method:'POST',body:new URLSearchParams({subscribed_fields:fields.join(',')})});
    if(saved.success!==true)throw Object.assign(new Error('Not confirmed'),{code:'UPDATE_NOT_CONFIRMED'});
   }
   const after=apply?await read():before,actual=after.find(a=>a.id===current.id);
   if(apply&&(!actual||fields.some(f=>!actual.subscribed_fields.includes(f))))throw Object.assign(new Error('Not persisted'),{code:'SUBSCRIPTIONS_NOT_PERSISTED'});
   report.pages.push({page_id:page.id,page:page.name,fb_page_id:page.fb_page_id,app_id:current.id,before:current.subscribed_fields,after:actual?.subscribed_fields||[],ready:required.every(f=>actual?.subscribed_fields?.includes(f))});
  }catch(e){report.pages.push({page_id:page.id,page:page.name,fb_page_id:page.fb_page_id,error_code:e.code||'PAGE_SUBSCRIPTION_CHECK_FAILED',error_subcode:e.subcode||null});}
 }
}finally{await db.end().catch(()=>{});fs.writeFileSync(new URL('../../data/ad-source-subscriptions-'+(apply?'activation':'audit')+'-2026-10-27.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,apps:report.apps.map(a=>({app_id:a.app_id,callback:a.callback,ready:a.ready,error_code:a.error_code})),pages:report.pages.map(p=>({page:p.page,app_id:p.app_id,ready:p.ready,error_code:p.error_code,fields:p.after}))},null,2));}
