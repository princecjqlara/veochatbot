import fs from 'node:fs';import pg from 'pg';
import {assertProjectCredentials,VEO_TARGET_PROJECT} from './lib/database-migration-safety.mjs';
const {connectionString}=assertProjectCredentials(process.env,VEO_TARGET_PROJECT),db=new pg.Client({connectionString,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:25000});
await db.connect();const pages=(await db.query('SELECT id,name,fb_page_id,access_token FROM pages ORDER BY name')).rows;
const approved=new Set(JSON.parse(fs.readFileSync('src/config/veo-pages.json','utf8')).map(p=>p.facebook_page_id).filter(Boolean));
const results=[];
async function read(page,endpoint){const r=await fetch('https://graph.facebook.com/v24.0/'+endpoint,{headers:{Authorization:'Bearer '+page.access_token},signal:AbortSignal.timeout(12000)});const b=await r.json();if(!r.ok||b.error)throw Object.assign(Error('Facebook read unavailable'),{code:b.error?.code||r.status});return b;}
try{
 for(let start=0;start<pages.length;start+=3)await Promise.all(pages.slice(start,start+3).map(async page=>{
  if(!approved.has(page.fb_page_id))throw Error('Unexpected Page in destination');
  const result={page_id:page.id,name:page.name,facebook_page_id:page.fb_page_id,status:'unverified'};
  try{
   const identity=await read(page,'me?fields=id,name');if(identity.id!==page.fb_page_id)throw Error('Page identity mismatch');
   const [apps,inbox]=await Promise.all([read(page,page.fb_page_id+'/subscribed_apps?fields=id'),read(page,page.fb_page_id+'/conversations?fields=id&limit=1')]);
   if(!Array.isArray(inbox.data)||!Array.isArray(apps.data))throw Error('Incomplete Facebook response');
   result.inbox_readable=true;result.status=apps.data.some(app=>app.id===process.env.FACEBOOK_CLIENT_ID)?'connected':'reconnect_required';
   if(result.status==='connected')await db.query('UPDATE pages SET automation_app_id=$2 WHERE id=$1',[page.id,process.env.FACEBOOK_CLIENT_ID]);
  }catch(e){result.code=e.code||null;result.status=[10,190,200].includes(e.code)?'reconnect_required':'verification_unavailable';}
  results.push(result);
 }));
 const report={target_project:VEO_TARGET_PROJECT,checked_at:new Date().toISOString(),pages:results,customer_messages_sent:0};fs.writeFileSync('.vercel/veo-reset/page-connections.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await db.end();}
