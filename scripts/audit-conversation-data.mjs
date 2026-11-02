// Read-only reconciliation. Receipts contain counts/IDs, never credentials or raw chats.
import fs from 'node:fs';import pg from 'pg';import ts from 'typescript';
// Use the production parser so order notices and explicit history resets follow
// exactly the same rules as the running synchronizer.
const compile=path=>ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const historyUrl=moduleUrl(compile('src/lib/messaging-auto-tag.ts'));
const {parseMessengerStageEvent}=await import(moduleUrl(compile('src/lib/messenger-stage-sync.ts').replaceAll('@/lib/messaging-auto-tag',historyUrl)));
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,query_timeout:120000});
const dir='.vercel/conversation-data-audit';fs.mkdirSync(dir,{recursive:true});
const receipt={started_at:new Date().toISOString(),read_only:true,customer_messages_sent:0,pages:[],profiles:[],integrity:{}};
const normalize=text=>String(text||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
function publicError(body,status){const e=body?.error||{};return{status,code:e.code||null,subcode:e.error_subcode||null,message:String(e.message||'Facebook did not return an accessible response').replace(/(?:EA[A-Za-z0-9_-]{30,}|access_token=[^\s&]+)/g,'[redacted]').slice(0,600)};}
async function graph(path,token,params={}){const url=path.startsWith('https:')?new URL(path):new URL('https://graph.facebook.com/v24.0/'+path);if(url.hostname!=='graph.facebook.com'||url.protocol!=='https:')throw Error('Invalid history cursor');url.searchParams.delete('access_token');for(const[k,v]of Object.entries(params))url.searchParams.set(k,String(v));const response=await fetch(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)});const body=await response.json();if(!response.ok||body.error)throw Object.assign(Error('Facebook history unavailable'),{detail:publicError(body,response.status)});return body;}
async function parallel(rows,fn,limit=3){let next=0;await Promise.all(Array.from({length:Math.min(limit,rows.length)},async()=>{while(next<rows.length)await fn(rows[next++]);}));}
const flush=()=>fs.writeFileSync(dir+'/report.json',JSON.stringify(receipt,null,2));
try{
 await db.connect();
 const pages=(await db.query(`SELECT p.id,p.name,p.fb_page_id,p.access_token,p.messaging_auto_tag_enabled,p.messaging_auto_tag_checked_at,
 p.messaging_auto_tag_last_error,(SELECT count(*)::int FROM user_pages up WHERE up.page_id=p.id) AS memberships,
 (SELECT count(*)::int FROM contacts c WHERE c.page_id=p.id) AS contacts FROM pages p ORDER BY p.name`)).rows;
 const configs=(await db.query('SELECT * FROM chatbot_configs ORDER BY page_id')).rows;fs.writeFileSync(dir+'/config-baseline.json',JSON.stringify(configs));
 receipt.inventory=(await db.query(`SELECT (SELECT count(*)::int FROM contacts) AS contacts,(SELECT count(*)::int FROM contact_tags) AS tag_assignments,
 (SELECT count(*)::int FROM tags) AS tags,(SELECT count(DISTINCT contact_id)::int FROM contact_profile_snapshots) AS reviewed_contacts,
 (SELECT count(*)::int FROM contact_profile_messages) AS stored_profile_messages,(SELECT count(*)::int FROM messenger_lead_stage_events) AS stage_events`)).rows[0];
 await parallel(pages,async page=>{
  const row={page_id:page.id,page:page.name,contacts:page.contacts,memberships:page.memberships,sync_enabled:page.messaging_auto_tag_enabled,last_success_at:page.messaging_auto_tag_checked_at,
   intentional_disconnect_recorded:false,access:null};
  const evidence=(await db.query(`SELECT action_type,summary,status,created_at FROM page_activity_history WHERE page_id=$1 AND (action_type~*'(disconnect|deauth|revoke)' OR summary~*'(disconnect|deauthoriz|revoked access)') ORDER BY created_at DESC LIMIT 10`,[page.id])).rows;
  const accessLog=(await db.query(`SELECT action,created_at FROM tokko_access_audit WHERE page_id=$1 AND action~*'(disconnect|deauth|revoke|remove)' ORDER BY created_at DESC LIMIT 10`,[page.id])).rows;
  row.connection_audit_evidence=[...evidence,...accessLog];row.intentional_disconnect_recorded=evidence.some(e=>e.status==='success'&&/disconnect|deauth/i.test(e.action_type));
  try{const r=await graph(page.fb_page_id+'/conversations',page.access_token,{fields:'id,updated_time',limit:1});if(!Array.isArray(r.data))throw Error('Malformed conversation response');row.access={readable:true,checked_at:new Date().toISOString()};}
  catch(e){row.access={readable:false,...(e.detail||{message:e.message}),checked_at:new Date().toISOString()};}
  receipt.pages.push(row);flush();console.log(JSON.stringify({page:row.page,readable:row.access.readable,error_code:row.access.code||null,subcode:row.access.subcode||null,disconnect_recorded:row.intentional_disconnect_recorded}));
 });
 receipt.integrity=(await db.query(`WITH latest AS(SELECT DISTINCT ON(contact_id) contact_id,stage FROM messenger_lead_stage_events WHERE applied ORDER BY contact_id,occurred_at DESC,observed_at DESC)
 SELECT (SELECT count(*)::int FROM latest e JOIN contacts c ON c.id=e.contact_id WHERE c.pipeline_stage_source='messenger' AND c.pipeline_stage<>e.stage) AS current_stage_mismatches,
 (SELECT count(*)::int FROM messenger_lead_stage_events e WHERE NOT EXISTS(SELECT 1 FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.contact_id=e.contact_id AND t.system_key=stage_history_tag_key(e.label))) AS missing_history_tags,
 (SELECT count(*)::int FROM contact_tags ct LEFT JOIN contacts c ON c.id=ct.contact_id LEFT JOIN tags t ON t.id=ct.tag_id WHERE c.id IS NULL OR t.id IS NULL) AS orphaned_tag_assignments,
 (SELECT count(*)::int FROM ad_contact_sources s JOIN contacts c ON c.id=s.contact_id WHERE s.page_id<>c.page_id) AS cross_page_origins,
 (SELECT count(*)::int FROM ad_contact_sources s WHERE s.attribution_status='verified_inline' AND (s.origin_ad_id IS NULL OR NOT EXISTS(SELECT 1 FROM ad_referral_events e WHERE e.event_key=s.origin_evidence_key AND e.page_id=s.page_id AND e.contact_id=s.contact_id AND e.ad_id=s.origin_ad_id))) AS unsupported_verified_origins,
 (SELECT count(*)::int FROM contact_profile_snapshots s JOIN contacts c ON c.id=s.contact_id WHERE s.page_id<>c.page_id) AS cross_page_profiles`)).rows[0];
 const snapshots=(await db.query(`SELECT DISTINCT ON(s.contact_id) s.*,c.psid,c.pipeline_stage,c.pipeline_stage_source,c.pipeline_stage_updated_at,c.messenger_stage_event_at,c.messenger_stage_message_id,cs.messenger_history_reset_at
 FROM contact_profile_snapshots s JOIN contacts c ON c.id=s.contact_id AND c.page_id=s.page_id
 LEFT JOIN chatbot_contact_states cs ON cs.page_id=c.page_id AND cs.contact_id=c.id ORDER BY s.contact_id,s.generation DESC`)).rows;
 await parallel(snapshots,async snapshot=>{
  const page=pages.find(p=>p.id===snapshot.page_id),row={contact_id:snapshot.contact_id,page:page.name,generation:snapshot.generation,cutoff:snapshot.source_cutoff_at,
   saved_messages:snapshot.message_count,citation_items:0,invalid_citations:0,meta_history:null};
  const messages=(await db.query('SELECT message_id,sent_at,sender,text,attachment_count,image_count FROM contact_profile_messages WHERE page_id=$1 AND contact_id=$2 AND generation=$3 ORDER BY sent_at,message_id',[snapshot.page_id,snapshot.contact_id,snapshot.generation])).rows;
  const sources=new Map(messages.map(m=>[m.message_id,m]));row.stored_message_count_matches=messages.length===snapshot.message_count;
  const payload=snapshot.payload;
  for(const item of [...payload.summary_points||[],...payload.facts||[],...payload.extracted_answers||[],...payload.answer_history||[]]){
   row.citation_items++;const proofs=item.evidence||[];const customerOnly=item.field||item.category&&!['purchase','promise'].includes(item.category);
   if(!proofs.length||proofs.some(proof=>{const source=sources.get(proof.message_id);return !source||source.sender==='unknown'||customerOnly&&source.sender!=='customer'||!normalize(proof.quote)||!normalize(source.text).includes(normalize(proof.quote));}))row.invalid_citations++;
  }
  try{
   const first=await graph(page.fb_page_id+'/conversations',page.access_token,{user_id:snapshot.psid,limit:1,fields:'id,messages.limit(100){id,message,from,created_time,attachments{mime_type,image_data}}'});
   if(!Array.isArray(first.data)||!first.data[0]?.messages)throw Error('No accessible conversation');let batch=first.data[0].messages,raw=[],seen=new Set();
   for(let n=0;;n++){
    if(!Array.isArray(batch.data))throw Error('Incomplete Facebook history page');raw.push(...batch.data);
    if(!batch.paging?.next)break;if(n>=299||seen.has(batch.paging.next))throw Error('History pagination did not finish');seen.add(batch.paging.next);batch=await graph(batch.paging.next,page.access_token);
   }
   const before=new Map(raw.filter(m=>Date.parse(m.created_time)<=Date.parse(snapshot.source_cutoff_at)).map(m=>[m.id,m]));
   const missing=messages.filter(m=>!before.has(m.message_id)).length,changed=messages.filter(m=>before.has(m.message_id)&&String(before.get(m.message_id).message||'')!==m.text).length;
   const added=[...before.keys()].filter(id=>!sources.has(id)).length;
   row.meta_history={complete:true,messages_at_cutoff:before.size,total_accessible_messages:new Set(raw.map(m=>m.id)).size,missing_stored_messages:missing,changed_texts:changed,newly_visible_older_messages:added,exact_snapshot_match:missing===0&&changed===0&&added===0};
   const stages=raw.map(m=>parseMessengerStageEvent(m,page.fb_page_id,{historyResetAt:snapshot.messenger_history_reset_at})).filter(Boolean).sort((a,b)=>Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
   const storedEvents=new Set((await db.query('SELECT message_id FROM messenger_lead_stage_events WHERE page_id=$1 AND contact_id=$2',[page.id,snapshot.contact_id])).rows.map(e=>e.message_id));
   row.observed_stage_events=stages.length;row.missing_stage_events=stages.filter(e=>!storedEvents.has(e.messageId));
   const stage=stages[0];
   if(stage){
    row.latest_meta_stage_at=stage.occurredAt;
    row.latest_meta_stage_superseded_by_manual=snapshot.pipeline_stage_source==='manual'&&Date.parse(stage.occurredAt)<Date.parse(snapshot.pipeline_stage_updated_at);
    row.latest_meta_stage_matches_saved=row.latest_meta_stage_superseded_by_manual||stage.messageId===snapshot.messenger_stage_message_id;
   }
  }catch(e){row.meta_history={complete:false,error:e.detail||e.message};}
  receipt.profiles.push(row);flush();console.log(JSON.stringify({profile:receipt.profiles.length,total:snapshots.length,page:page.name,citations_invalid:row.invalid_citations,meta_exact:row.meta_history.exact_snapshot_match??null}));
 },2);
 const actual=(await db.query('SELECT * FROM chatbot_configs ORDER BY page_id')).rows;receipt.bot_configuration_preserved=JSON.stringify(actual)===JSON.stringify(configs);
 receipt.completed_at=new Date().toISOString();receipt.coverage={all_stored_contacts:receipt.inventory.contacts,all_stored_tag_assignments:receipt.inventory.tag_assignments,full_review_profiles_checked:receipt.profiles.length,
  full_meta_histories_checked:receipt.profiles.filter(p=>p.meta_history.complete).length,historical_contacts_without_full_review:receipt.inventory.contacts-receipt.profiles.length,
  statement:'Stored-data integrity covers the whole database. Full message/citation reconciliation covers saved reviews only; unread historical threads are not certified.'};
 receipt.summary={pages_readable:receipt.pages.filter(p=>p.access.readable).length,pages_unreadable:receipt.pages.filter(p=>!p.access.readable).length,invalid_citations:receipt.profiles.reduce((n,p)=>n+p.invalid_citations,0),changed_snapshots:receipt.profiles.filter(p=>p.meta_history.complete&&!p.meta_history.exact_snapshot_match).length,
  missing_observed_stage_events:receipt.profiles.reduce((n,p)=>n+(p.missing_stage_events?.length||0),0),latest_observed_stage_mismatches:receipt.profiles.filter(p=>p.latest_meta_stage_matches_saved===false).length};flush();console.log(JSON.stringify({completed:true,summary:receipt.summary,integrity:receipt.integrity,coverage:receipt.coverage},null,2));
}catch(e){receipt.error=e.message;flush();console.error(JSON.stringify({error:e.message}));process.exitCode=1;}finally{await db.end();}
