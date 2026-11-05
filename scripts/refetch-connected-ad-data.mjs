// Refresh Page-owned ad previews, inventory and recent daily metrics. Never sends
// customer messages, changes budgets or infers payments from conversation text.
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {build} from 'esbuild';import pg from 'pg';import {createClient} from '@supabase/supabase-js';
import {connectedPageScope} from './lib/connected-pages.mjs';
import {connectedAdInventory} from './lib/connected-ad-inventory.mjs';
const dir=path.resolve('.vercel/historical-leads'),file=path.join(dir,'connected-ads-refresh.json');fs.mkdirSync(dir,{recursive:true});
const report={started_at:new Date().toISOString(),refresh_job_id:process.argv.find(value=>value.startsWith('--refresh-job-id='))?.slice(17)||null,scope:'connected_pages',complete:false,inventory_complete:false,daily_spend_complete:false,page_previews_complete:false,customer_messages_sent:0,ad_budgets_changed:0,financial_records_created:0,inventory_records_saved:0,daily_spend_records_saved:0,page_previews_resolved:0,requests:0,errors:[]};
const flush=()=>fs.writeFileSync(file,JSON.stringify(report,null,2)),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,query_timeout:20000});db.on('error',()=>{});
const supabase=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const bundle=path.join(dir,'ad-refresh-runtime.cjs');await build({stdin:{contents:"export {catalogMetadata,creativePageId,marketingConnection,resolveAdCreative} from './src/lib/facebook-ad-catalog.ts'; export {DAILY_INSIGHT_FIELDS,normalizeDailySpend,dailyDeliveryMetrics,alignedWithPht} from './src/lib/ad-daily-spend.ts';",resolveDir:process.cwd(),loader:'ts'},outfile:bundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const {catalogMetadata,creativePageId,marketingConnection,resolveAdCreative,DAILY_INSIGHT_FIELDS,normalizeDailySpend,dailyDeliveryMetrics,alignedWithPht}=createRequire(import.meta.url)(bundle);
const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10),[year,month]=today.split('-').map(Number);
const from=process.argv.find(value=>value.startsWith('--from='))?.slice(7)||new Date(Date.UTC(year,month-2,1)).toISOString().slice(0,10),to=process.argv.find(value=>value.startsWith('--to='))?.slice(5)||today;
if(!/^20\d{2}-\d{2}-\d{2}$/.test(from)||!/^20\d{2}-\d{2}-\d{2}$/.test(to)||![from,to].every(day=>Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day)||from>to||to>today||Date.parse(to)-Date.parse(from)>93*86400000)throw Error('Choose a valid completed/current reporting period of at most 94 days');
Object.assign(report,{from,to,today_provisional:to===today});
const clean=error=>({code:error.code||null,message:String(error.message||'Refresh unavailable').replace(/EA[A-Za-z0-9_-]{25,}|access_token=[^\s&]+|https?:\/\/[^\s]+/g,'[redacted]').slice(0,250)});
let capacityExceeded=false;
async function graph(target,token,params={}){
 if(capacityExceeded)throw Object.assign(Error('Bulk ad reads are waiting for Meta capacity'),{code:4});
 const url=new URL('https://graph.facebook.com/v24.0/'+target);for(const[key,value]of Object.entries(params))url.searchParams.set(key,String(value));report.requests++;
 const response=await fetch(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)}),body=await response.json();
 if(!response.ok||body.error)throw Object.assign(Error(body.error?.message||'Ad data is unavailable'),{code:body.error?.code||response.status});
 const usage=[JSON.parse(response.headers.get('x-page-usage')||'{}'),JSON.parse(response.headers.get('x-app-usage')||'{}')].flatMap(Object.values),highest=Math.max(0,...usage.map(Number));
 if(highest>95){capacityExceeded=true;throw Object.assign(Error('Bulk ad reads are waiting for Meta capacity'),{code:4});}if(highest>80)await sleep(5000);return body;
}
try{
 await db.connect();const candidates=(await db.query('SELECT p.id,p.name,p.fb_page_id,p.access_token FROM pages p WHERE EXISTS(SELECT 1 FROM user_pages u WHERE u.page_id=p.id) ORDER BY p.name')).rows;
 const scope=await connectedPageScope(candidates,page=>graph(page.fb_page_id+'/conversations',page.access_token,{fields:'id',limit:1}));
 report.connected_pages=scope.connected.map(page=>({page_id:page.id,page:page.name}));report.disconnected_pages_excluded=scope.excluded;report.unverified_pages=scope.unverified;
 if(capacityExceeded)throw Object.assign(Error('Connected-Page checks are waiting for Meta capacity'),{code:4});
 const ids=scope.connected.map(page=>page.id),allowedPages=new Map(scope.connected.map(page=>[page.fb_page_id,page.id])),byId=new Map(scope.connected.map(page=>[page.id,page]));
 const token=process.env.META_USER_ACCESS_TOKEN,connection=await marketingConnection(token);
 report.ad_account_access=connection.status;
 if(ids.length&&connection.status==='ready'&&connection.accounts.length&&!connection.partial){
  let inventoryOK=true,dailyOK=true;
  for(const account of connection.accounts){
   try{
    const accountData=await graph(account.id,token,{fields:'id,currency,timezone_name'});if(accountData.id!==account.id||!/^[A-Z]{3}$/.test(accountData.currency||'')||typeof accountData.timezone_name!=='string')throw Error('Ad-account reporting metadata is incomplete');
    let after,finished=false;const seen=new Set(),accountAds=new Map();
    for(let step=0;step<100;step++){
     const body=await graph(account.id+'/ads',token,{fields:'id,name,account_id,effective_status,campaign{id,name},adset{id,name},creative{id,name,thumbnail_url,effective_object_story_id,object_story_id,object_story_spec}',limit:100,...(after?{after}:{})});
     const {records,owners}=connectedAdInventory(body.data,allowedPages,account.id,creativePageId,catalogMetadata);for(const[id,page]of owners){if(accountAds.has(id)&&accountAds.get(id)!==page)throw Error('Ad inventory has conflicting Page ownership');accountAds.set(id,page);}
     if(records.length){const saved=await supabase.rpc('save_ad_catalog_metadata',{p_records:records});if(saved.error)throw Error('Could not save connected-Page ad inventory');report.inventory_records_saved+=records.length;flush();}
     if(!body.paging?.next){finished=true;break;}after=body.paging.cursors?.after;if(!after||seen.has(after))throw Error('Ad inventory pagination did not finish');seen.add(after);await sleep(250);
    }
    if(!finished)throw Error('Ad inventory exceeded its bounded pagination limit');
    const adIds=[...accountAds.keys()];
    for(let offset=0;offset<adIds.length;offset+=20)for(let start=Date.parse(from+'T00:00:00Z');start<=Date.parse(to+'T00:00:00Z');start+=7*86400000){
     const selected=adIds.slice(offset,offset+20),since=new Date(start).toISOString().slice(0,10),until=new Date(Math.min(start+6*86400000,Date.parse(to+'T00:00:00Z'))).toISOString().slice(0,10),rows=new Map(),cursors=new Set();let cursor,complete=false;
     for(let step=0;step<100;step++){
      const body=await graph(account.id+'/insights',token,{fields:DAILY_INSIGHT_FIELDS,level:'ad',time_increment:1,action_report_time:'conversion',use_unified_attribution_setting:'true',filtering:JSON.stringify([{field:'ad.id',operator:'IN',value:selected}]),time_range:JSON.stringify({since,until}),limit:100,...(cursor?{after:cursor}:{})});
      if(!Array.isArray(body.data))throw Error('Daily ad report is incomplete');
      for(const raw of body.data){const value=normalizeDailySpend(raw,accountData,new Map(selected.map(id=>[id,accountAds.get(id)])),since,until);if(!value)throw Error('Daily ad report includes an unrequested creative');const key=value.ad_id+':'+value.spend_date;if(rows.has(key))throw Error('Daily ad report has duplicate rows');rows.set(key,{...value,...dailyDeliveryMetrics(raw),report_complete:value.spend_date<today,reported_zero:false});}
      if(!body.paging?.next){complete=true;break;}cursor=body.paging.cursors?.after;if(!cursor||cursors.has(cursor))throw Error('Daily ad pagination did not finish');cursors.add(cursor);
     }
     if(!complete)throw Error('Daily ad report exceeded its bounded pagination limit');
     for(let ms=start;ms<=Date.parse(until+'T00:00:00Z');ms+=86400000)for(const ad of selected){const day=new Date(ms).toISOString().slice(0,10),key=ad+':'+day;if(!rows.has(key))rows.set(key,{page_id:accountAds.get(ad),ad_id:ad,account_id:account.id.slice(4),spend_date:day,currency:accountData.currency,account_timezone:accountData.timezone_name,pht_aligned:alignedWithPht(day,accountData.timezone_name),amount:0,impressions:0,clicks:0,reach:0,link_clicks:0,messaging_started:0,video_plays:0,video_thruplays:0,video_complete:0,action_report_time:'conversion',attribution_setting:'adset_unified',report_complete:day<today,reported_zero:day<today,checked_at:new Date().toISOString()});}
     const saved=await supabase.from('ad_daily_spend').upsert([...rows.values()],{onConflict:'page_id,ad_id,spend_date,account_id'});if(saved.error)throw Error('Could not save completed daily ad report');report.daily_spend_records_saved+=rows.size;flush();await sleep(250);
    }
   }catch(error){inventoryOK=false;dailyOK=false;report.errors.push({ad_account:account.id,...clean(error)});flush();}
  }
  report.inventory_complete=inventoryOK;report.daily_spend_complete=dailyOK;
 }else report.ad_account_refresh_blocked=ids.length?'The background worker has no usable ad-account session. The signed-in calendar can use its Facebook ad-account read session. No spend was inferred.':'No connected Pages were verified; no ad inventory or spend was imported.';
 if(capacityExceeded)throw Object.assign(Error('Ad preview reads are waiting for Meta capacity'),{code:4});
 const ads=ids.length?(await db.query('SELECT page_id,ad_id,post_id FROM ad_source_catalog WHERE page_id=ANY($1::uuid[]) ORDER BY page_id,ad_id',[ids])).rows:[];
 let previewFailures=0;for(const ad of ads){try{const page=byId.get(ad.page_id),result=await resolveAdCreative({pageId:page.id,facebookPageId:page.fb_page_id,pageToken:page.access_token,userToken:token,ad});const saved=await supabase.rpc('save_ad_catalog_metadata',{p_records:[result.patch]});if(saved.error)throw Error('Could not save Page ad preview');if(result.resolved)report.page_previews_resolved++;else previewFailures++;}catch(error){previewFailures++;report.errors.push({page_id:ad.page_id,ad_id:ad.ad_id,...clean(error)});}await sleep(100);}
 report.page_previews_complete=previewFailures===0;report.complete=scope.unverified.length===0&&report.inventory_complete&&report.daily_spend_complete&&report.page_previews_complete;report.completed_at=new Date().toISOString();
}catch(error){report.errors.push(clean(error));report.failed_at=new Date().toISOString();process.exitCode=1;}finally{await Promise.race([db.end().catch(()=>{}),sleep(1000)]);flush();console.log(JSON.stringify(report,null,2));}
