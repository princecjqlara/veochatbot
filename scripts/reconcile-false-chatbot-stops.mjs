import {createRequire} from 'node:module';
// Read-only unless --apply is supplied. Node 22+ requires --experimental-strip-types.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import pg from 'pg';
import {classifyMessengerHistoryMessage,isMessengerAutomaticNotice,loadMessengerHistoryForStopCheck} from '../src/lib/messaging-auto-tag.ts';
import {classifyChatbotStopIntent} from '../src/lib/chatbot-control.ts';
const require=createRequire(new URL('../package.json',import.meta.url));const {createClient}=require('@supabase/supabase-js');
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
await mkdir(new URL('../../data/',import.meta.url),{recursive:true});
const checked=r=>{if(r.error)throw new Error(r.error.message);return r.data;};
const configs=checked(await db.from('chatbot_configs').select('page_id').eq('enabled',true));
const pages=checked(await db.from('pages').select('id,name,fb_page_id,access_token').in('id',configs.map(c=>c.page_id)));
const pool=new pg.Pool({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:1,connectionTimeoutMillis:15000});
pool.on('error',()=>console.warn('An idle database connection was lost; completed changes remain committed.'));
const apply=process.argv.includes('--apply');const at=new Date().toISOString();const stamp=at.replaceAll(':','-');const rows=[];let candidates;
try{
 candidates=(await pool.query(`SELECT to_jsonb(s) AS state,to_jsonb(c) AS contact FROM chatbot_contact_states s JOIN contacts c ON c.id=s.contact_id AND c.page_id=s.page_id WHERE s.page_id=ANY($1::uuid[]) AND s.status='stopped' AND s.stop_reason='manual' AND s.last_bot_reply_at IS NULL AND c.pipeline_stage='new' AND c.pipeline_stage_source='messenger' AND s.created_at>NOW()-INTERVAL '48 hours' ORDER BY s.created_at DESC`,[pages.map(p=>p.id)])).rows;
 if(process.argv.includes('--audit-file')){
  const audit=JSON.parse(await readFile(process.argv[process.argv.indexOf('--audit-file')+1],'utf8'));
  if(Date.now()-new Date(audit.at).getTime()>30*60000)throw new Error('Prior audit is too old for a focused recheck');
  const eligibleIds=new Set(audit.rows.filter(r=>r.eligible).map(r=>r.contactId));candidates=candidates.filter(r=>eligibleIds.has(r.contact.id));
 }
 console.log('CANDIDATE_COUNT',candidates.length);
 for(let i=0;i<candidates.length;i+=5){
  const batch=await Promise.all(candidates.slice(i,i+5).map(async({state,contact})=>{
   const page=pages.find(p=>p.id===state.page_id);const row={page:page.name.trim(),pageId:page.id,contactId:contact.id,state,contact,eligible:false,reason:null};
   try{
    const boundary=new Date(state.started_at).getTime();if(!Number.isFinite(boundary)||Date.now()-boundary>7*86400000){row.reason='Intake boundary is unavailable or expired';return row;}
    const url=new URL(`https://graph.facebook.com/v24.0/${page.fb_page_id}/conversations`);url.searchParams.set('user_id',contact.psid);url.searchParams.set('limit','1');url.searchParams.set('fields','id,messages.limit(100){id,message,from,created_time,tags}');
    const response=await fetch(url,{headers:{Authorization:`Bearer ${page.access_token}`},signal:AbortSignal.timeout(20000)});const body=await response.json();if(!response.ok||body.error)throw new Error(body.error?.message||'Messenger history unavailable');
    const initial=body.data?.[0]?.messages;if(!Array.isArray(initial?.data))throw new Error('Conversation was not returned');
    const recentPage=initial.data.filter(m=>m.from?.id===page.fb_page_id&&new Date(m.created_time||0).getTime()>=boundary-5000&&!isMessengerAutomaticNotice(m.message||''));
    if(recentPage.length){
     const attrs=checked(await db.from('outbound_message_events').select('message_id,source_type').eq('page_id',page.id).in('message_id',recentPage.map(m=>m.id)));
     if(recentPage.some(m=>!attrs.some(a=>a.message_id===m.id&&a.source_type!=='manual'))){row.reason='Current staff reply or unattributed Page message';return row;}
    }
    const history=await loadMessengerHistoryForStopCheck({facebookPageId:page.fb_page_id,accessToken:page.access_token,initialPage:initial,requireAvailable:true,humanHandoffSince:state.started_at});
    if(history.some(m=>classifyMessengerHistoryMessage(m,page.fb_page_id,{humanHandoffSince:state.started_at}))){row.reason='Verified lead-stage, order, or current staff handoff';return row;}
    if(history.some(m=>m.from?.id!==page.fb_page_id&&typeof m.message==='string'&&classifyChatbotStopIntent(m.message,{stopOnOptOut:true,stopOnRefusal:true}))){row.reason='Customer opt-out or refusal in checked history';return row;}
    const hasOldStaff=history.some(m=>m.from?.id===page.fb_page_id&&new Date(m.created_time||0).getTime()<boundary&&m.tags?.data?.some(t=>t.name==='source:mobile'));
    const hasAutomaticNotice=history.some(m=>m.from?.id===page.fb_page_id&&isMessengerAutomaticNotice(m.message||''));
    if(!hasOldStaff&&!hasAutomaticNotice){row.reason='No verified false-stop trigger';return row;}
    row.eligible=true;row.reason=hasOldStaff?'Only staff replies preceding first intake':'Automatic Meta notice without staff handoff';row.checkedMessages=history.length;return row;
   }catch(error){row.reason=error.message;row.auditError=true;return row;}
  }));
  rows.push(...batch);console.log('PROGRESS',JSON.stringify({checked:rows.length,total:candidates.length,eligible:rows.filter(r=>r.eligible).length,errors:rows.filter(r=>r.auditError).length}));
 }
 const eligible=rows.filter(r=>r.eligible);await writeFile(new URL(`../../data/reply-gap-reconcile-${apply?'apply':'audit'}-${stamp}.json`,import.meta.url),JSON.stringify({at,apply,candidates:candidates.length,rows},null,2),{flag:'wx'});
 const restored=[];
 if(apply){
  await writeFile(new URL(`../../data/reply-gap-restoration-backup-${stamp}.json`,import.meta.url),JSON.stringify({at,records:eligible.map(r=>({state:r.state,contact:r.contact,reason:r.reason}))},null,2),{flag:'wx'});
  for(const row of eligible){
   // One atomic statement locks both snapshots and avoids an idle checked-out connection.
   const result=await pool.query(`WITH eligible AS (
    SELECT c.id AS contact_id,s.id AS state_id FROM contacts c JOIN chatbot_contact_states s ON s.contact_id=c.id AND s.page_id=c.page_id
    WHERE c.id=$1 AND c.page_id=$2 AND c.pipeline_stage='new' AND c.pipeline_stage_source='messenger'
     AND c.pipeline_stage_updated_at IS NOT DISTINCT FROM $3::timestamptz AND c.last_inbound_at IS NOT DISTINCT FROM $7::timestamptz
     AND s.id=$4 AND s.status='stopped' AND s.stop_reason='manual' AND s.last_bot_reply_at IS NULL AND s.updated_at=$5::timestamptz AND s.started_at=$6::timestamptz
    FOR UPDATE OF c,s
   ), restored_state AS (
    UPDATE chatbot_contact_states s SET status='active',stop_reason=NULL,stopped_at=NULL,updated_at=NOW()
    FROM eligible e WHERE s.id=e.state_id RETURNING s.contact_id,s.page_id
   ) UPDATE contacts c SET pipeline_stage_source='system',pipeline_stage_updated_at=NOW()
    FROM restored_state s WHERE c.id=s.contact_id AND c.page_id=s.page_id RETURNING c.id`,
    [row.contactId,row.pageId,row.contact.pipeline_stage_updated_at,row.state.id,row.state.updated_at,row.state.started_at,row.contact.last_inbound_at]);
   if(result.rowCount!==1){row.concurrentChange=true;continue;}
   restored.push({page:row.page,contactId:row.contactId,reason:row.reason});
   await writeFile(new URL('../../data/reply-gap-restoration-progress.json',import.meta.url),JSON.stringify({at,restoredContacts:restored},null,2));
  }
 }
 const reasons={};for(const r of rows)reasons[r.reason]=(reasons[r.reason]||0)+1;
 const report={at,apply,candidates:candidates.length,eligible:eligible.length,restored:restored.length,restoredContacts:restored,reasons,noMessengerMessagesSent:true};await writeFile(new URL(`../../data/reply-gap-reconcile-${apply?'result':'summary'}.json`,import.meta.url),JSON.stringify(report,null,2));console.log('SUMMARY',JSON.stringify({...report,restoredContacts:undefined}));
}finally{await pool.end();}
