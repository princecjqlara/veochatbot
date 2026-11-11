import fs from 'node:fs';
import assert from 'node:assert/strict';
const mode=process.argv[2]||'--inspect';assert(['--inspect','--apply','--verify'].includes(mode),'Choose --inspect, --apply or --verify');
const apiKey=process.env.CRONJOB_API_KEY,secret=process.env.CRON_SECRET;
assert(apiKey,'Load the existing cron-job.org API key as CRONJOB_API_KEY');
const target='https://veochatbot.vercel.app/api/cron/meta-ads-sync';
const schedule={timezone:'Asia/Manila',expiresAt:0,hours:[-1],mdays:[-1],minutes:[0],months:[-1],wdays:[-1]};
async function api(path,method='GET',body){
 const r=await fetch('https://api.cron-job.org'+path,{method,headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json',Accept:'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw Error('cron-job.org request failed (HTTP '+r.status+'); verify API-key access');
 return r.status===204?{}:await r.json();
}
const summary=j=>({jobId:j.jobId,title:j.title,enabled:j.enabled,url:new URL(j.url).origin+new URL(j.url).pathname,schedule:j.schedule,lastStatus:j.lastStatus,nextExecution:j.nextExecution,authorizationConfigured:!!j.extendedData?.headers?.Authorization});
try{
 const listing=await api('/jobs');assert(listing.someFailed!==true,'The job listing is incomplete; retry without changing jobs');
 const matches=(listing.jobs||[]).filter(j=>{try{const url=new URL(j.url),wanted=new URL(target);return url.hostname===wanted.hostname&&url.pathname===wanted.pathname;}catch{return false;}});
 const requested=process.env.META_ADS_CRON_JOB_ID;
 if(mode==='--inspect'){console.log(JSON.stringify({target,matches:matches.map(summary),otherWorkspaceJobs:(listing.jobs||[]).filter(j=>{try{return new URL(j.url).hostname===new URL(target).hostname;}catch{return false;}}).map(summary),changed:0}));}
 else{
  assert(matches.length>0,'No existing Meta Ads cron-job.org job targets this endpoint. No job was created or changed.');
  const job=requested?matches.find(j=>String(j.jobId)===requested):matches.length===1?matches[0]:null;
  assert(job,'Several matching jobs exist; select the intended existing job with META_ADS_CRON_JOB_ID');
  const before=(await api('/jobs/'+job.jobId)).jobDetails;assert(before&&before.url===job.url,'Job changed during inspection');
  if(mode==='--apply'){
   assert(secret,'Load the production CRON_SECRET before updating the job');
   fs.mkdirSync('.vercel/meta-ads-cron-job-org',{recursive:true});
   fs.writeFileSync('.vercel/meta-ads-cron-job-org/before-'+Date.now()+'.private.json',JSON.stringify(before,null,2));
   const retainedHeaders=Object.fromEntries(Object.entries(before.extendedData?.headers||{}).filter(([name])=>name.toLowerCase()!=='authorization'));
   await api('/jobs/'+job.jobId,'PATCH',{job:{url:target,enabled:true,saveResponses:false,requestMethod:0,redirectSuccess:false,schedule,extendedData:{...(before.extendedData||{}),headers:{...retainedHeaders,Authorization:'Bearer '+secret}}}});
  }
  const after=(await api('/jobs/'+job.jobId)).jobDetails;
  assert.equal(after.url,target);assert.equal(after.enabled,true);assert.equal(after.requestMethod,0);assert.deepEqual(after.schedule,schedule);
  if(secret)assert.equal(after.extendedData?.headers?.Authorization,'Bearer '+secret,'The job must send the production scheduler secret');
  const result={passed:true,mode,job:summary(after),changed:mode==='--apply'?1:0,manualRuns:0};
  if(mode==='--verify'){const history=await api('/jobs/'+job.jobId+'/history');result.recentExecutions=(history.history||[]).slice(0,3).map(h=>({date:h.date,httpStatus:h.httpStatus,status:h.status}));}
  fs.mkdirSync('.vercel/meta-ads-cron-job-org',{recursive:true});fs.writeFileSync('.vercel/meta-ads-cron-job-org/last-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }
}catch(e){console.error(JSON.stringify({passed:false,error:e.message}));process.exitCode=1;}
