// Read-only, resumable Messenger collection for deterministic data repairs.
import fs from'node:fs';import path from'node:path';import{gzipSync,gunzipSync}from'node:zlib';import pg from'pg';
const action=process.argv.includes('--histories')?'histories':'list',dir=path.resolve('.vercel/historical-leads/live');
fs.mkdirSync(path.join(dir,'indexes'),{recursive:true});fs.mkdirSync(path.join(dir,'histories'),{recursive:true});
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},query_timeout:120000,connectionTimeoutMillis:15000});db.on('error',()=>{});
const receipt={action,started_at:new Date().toISOString(),ai_calls:0,customer_messages_sent:0,requests:0,pages:[],histories:0,messages:0,errors:[]};
const clean=e=>({code:e.code||null,subcode:e.subcode||null,message:String(e.message).replace(/EA[A-Za-z0-9_-]{25,}|access_token=[^\s&]+|https?:\/\/[^\s]+/g,'[redacted]').slice(0,500)});
const flush=()=>fs.writeFileSync(path.join(dir,action+'-receipt.json'),JSON.stringify(receipt,null,2));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function safeUrl(value){const url=new URL(value.startsWith('https:')?value:'https://graph.facebook.com/v24.0/'+value);if(url.protocol!=='https:'||url.hostname!=='graph.facebook.com')throw Error('Invalid Messenger cursor');url.searchParams.delete('access_token');return url;}
let capacityExceeded=false;
async function graph(value,page,options){
 if(capacityExceeded)throw Object.assign(Error('Bulk reads are waiting for Meta capacity; saved sources are retained'),{code:4});
 receipt.requests++;const response=await fetch(safeUrl(value),{...options,headers:{Authorization:'Bearer '+page.access_token,...options?.headers},signal:AbortSignal.timeout(20000)}),body=await response.json();
 if(!response.ok||body.error)throw Object.assign(Error(body.error?.message||'Messenger read failed'),{code:body.error?.code||response.status,subcode:body.error?.error_subcode});
 const usage=[JSON.parse(response.headers.get('x-page-usage')||'{}'),JSON.parse(response.headers.get('x-app-usage')||'{}')].flatMap(Object.values),highest=Math.max(...usage.map(Number),0);receipt.maximum_observed_usage=Math.max(receipt.maximum_observed_usage||0,highest);if(highest>95){capacityExceeded=true;throw Object.assign(Error('Bulk reads stopped to leave capacity for live Page activity'),{code:4});}if(highest>80)await sleep(5000);
 return body;
}
async function parallel(rows,fn,n=2){let offset=0;await Promise.all(Array.from({length:Math.min(n,rows.length)},async()=>{while(offset<rows.length)await fn(rows[offset++]);}));}
try{
 await db.connect();const pages=(await db.query("SELECT p.id,p.name,p.fb_page_id,p.access_token,EXISTS(SELECT 1 FROM chatbot_configs b WHERE b.page_id=p.id AND b.enabled) AS chatbot_enabled FROM pages p WHERE EXISTS(SELECT 1 FROM contacts c WHERE c.page_id=p.id) ORDER BY p.name")).rows;
 const known=new Map();for(const page of pages){known.set(page.id,new Set((await db.query('SELECT psid FROM contacts WHERE page_id=$1',[page.id])).rows.map(c=>c.psid)));}await db.end();
 const archive=new Map();if(fs.existsSync('.vercel/historical-leads/manifest.jsonl'))for(const line of fs.readFileSync('.vercel/historical-leads/manifest.jsonl','utf8').trim().split('\n')){const row=JSON.parse(line);if(row.complete)archive.set(row.page_id+':'+row.psid,Date.parse(row.source_cutoff_at));}
 const archivedPages=new Set([...archive.keys()].map(key=>key.slice(0,36)));pages.sort((a,b)=>Number(b.chatbot_enabled)-Number(a.chatbot_enabled)||Number(archivedPages.has(b.id))-Number(archivedPages.has(a.id))||a.name.localeCompare(b.name));
 if(action==='list')await parallel(pages,async page=>{
  const file=path.join(dir,'indexes',page.id+'.json'),old=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
  if(old?.complete&&Date.now()-Date.parse(old.started_at)<3600000){receipt.pages.push({page:page.name,conversations:old.conversations.length,complete:true,cached:true});return;}
  const index=old&&!old.complete&&!old.error?old:{page_id:page.id,fb_page_id:page.fb_page_id,page:page.name,started_at:new Date().toISOString(),conversations:[],next:page.fb_page_id+'/conversations?fields=id,participants,updated_time&limit=100',complete:false};
  const seen=new Set();try{while(index.next){if(seen.has(index.next))throw Error('Repeated conversation cursor');seen.add(index.next);const url=safeUrl(index.next);url.searchParams.set('limit','500');let body;try{body=await graph(url.href,page);}catch(e){if(e.code!==100||!/limit/i.test(e.message))throw e;url.searchParams.set('limit','100');body=await graph(url.href,page);}if(!Array.isArray(body.data))throw Error('Incomplete conversation list');index.conversations.push(...body.data);index.next=body.paging?.next?safeUrl(body.paging.next).href:null;index.complete=!index.next;fs.writeFileSync(file,JSON.stringify(index));if(index.conversations.length%1000===0)console.log(JSON.stringify({page:page.name,listed:index.conversations.length}));await sleep(100);}}
  catch(e){index.error=clean(e);fs.writeFileSync(file,JSON.stringify(index));}
  receipt.pages.push({page:page.name,conversations:index.conversations.length,complete:index.complete,error:index.error});flush();
 });
 else{
  const fields='id,message,from,created_time,attachments{mime_type,image_data},tags';
  const manifest=[];
  await parallel(pages,async page=>{
   const indexPath=path.join(dir,'indexes',page.id+'.json');if(!fs.existsSync(indexPath))return;const index=JSON.parse(fs.readFileSync(indexPath,'utf8'));if(!index.complete){receipt.pages.push({page:page.name,skipped:'Incomplete or unavailable inbox list',error:index.error});return;}
   const queue=[];for(const conv of index.conversations){const people=conv.participants?.data?.filter(p=>p.id!==page.fb_page_id)||[];if(people.length!==1||!known.get(page.id).has(people[0].id))continue;const psid=people[0].id;if(!/^\d+$/.test(psid))continue;if(archive.get(page.id+':'+psid)>=Date.parse(conv.updated_time))continue;const file=path.join(dir,'histories',page.id+'_'+psid+'.json.gz');if(fs.existsSync(file)){try{const saved=JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8'));if(saved.complete&&saved.psid===psid&&saved.fb_page_id===page.fb_page_id&&(saved.index_started_at===index.started_at||saved.source_cutoff_at===index.started_at||Date.parse(saved.source_cutoff_at)>=Date.parse(conv.updated_time))){manifest.push({page_id:page.id,fb_page_id:page.fb_page_id,psid,file:path.relative(path.resolve('..'),file)});continue;}}catch{}}queue.push({conv,psid,file});}
   let failed=false;for(let offset=0;offset<queue.length&&!failed;offset+=20){const group=queue.slice(offset,offset+20);try{
    const batchStartedAt=new Date().toISOString();const batch=group.map((item,i)=>({method:'GET',relative_url:'v24.0/'+encodeURIComponent(item.conv.id)+'/messages?fields='+encodeURIComponent(fields)+'&limit=100',name:'lead'+i}));
    const response=await graph('',page,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({batch:JSON.stringify(batch)})});if(!Array.isArray(response)||response.length!==group.length)throw Error('Incomplete Messenger batch');
    for(let i=0;i<group.length;i++){const item=group[i],part=response[i];let body=JSON.parse(part.body||'{}');if(part.code!==200||body.error||!Array.isArray(body.data)){const error=Object.assign(Error(body.error?.message||'Conversation unavailable'),{code:body.error?.code||part.code});receipt.errors.push({page:page.name,conversation_id:item.conv.id,...clean(error)});if([4,17,32,190,200,613,80004].includes(error.code))failed=true;continue;}
     const raw=[...body.data],seen=new Set();try{while(body.paging?.next){const next=safeUrl(body.paging.next).href;if(seen.has(next)||raw.length>50000)throw Error('Incomplete or repeated message pagination');seen.add(next);body=await graph(next,page);if(!Array.isArray(body.data))throw Error('Missing history page');raw.push(...body.data);}
      const source={page_id:page.id,fb_page_id:page.fb_page_id,psid:item.psid,conversationId:item.conv.id,complete:true,source_cutoff_at:batchStartedAt,index_started_at:index.started_at,fetchedAt:new Date().toISOString(),updatedTime:item.conv.updated_time,messages:raw};fs.writeFileSync(item.file+'.tmp',gzipSync(JSON.stringify(source)));fs.renameSync(item.file+'.tmp',item.file);manifest.push({page_id:page.id,fb_page_id:page.fb_page_id,psid:item.psid,file:path.relative(path.resolve('..'),item.file)});receipt.histories++;receipt.messages+=raw.length;
     }catch(e){receipt.errors.push({page:page.name,conversation_id:item.conv.id,...clean(e)});}
    }flush();if(offset%200===0)console.log(JSON.stringify({page:page.name,processed:Math.min(offset+20,queue.length),queued:queue.length,histories:receipt.histories,messages:receipt.messages}));await sleep(200);
   }catch(e){receipt.errors.push({page:page.name,...clean(e)});failed=true;flush();}}
   receipt.pages.push({page:page.name,queued:queue.length,blocked:failed});flush();
  });
  fs.writeFileSync(path.join(dir,'sources.json'),JSON.stringify(manifest));
 }
 receipt.completed_at=new Date().toISOString();receipt.passed=receipt.errors.length===0;receipt.coverage_complete=receipt.pages.every(page=>action==='list'?page.complete:!page.skipped&&!page.blocked);flush();console.log(JSON.stringify({...receipt,pages:receipt.pages,errors:receipt.errors.slice(0,20)},null,2));
}catch(e){receipt.error=clean(e);receipt.passed=false;flush();console.error(JSON.stringify(receipt.error));process.exitCode=1;await db.end().catch(()=>{});}
