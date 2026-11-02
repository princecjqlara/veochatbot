// Only repair events reconciled with a complete, recent Meta history audit.
// Default is dry-run; --apply uses the same ordered/idempotent RPC as production.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import pg from 'pg';
import ts from 'typescript';
const dir='.vercel/conversation-data-audit';
const audit=JSON.parse(fs.readFileSync(dir+'/report.json','utf8'));
assert(audit.read_only && audit.completed_at && !audit.error, 'A completed audit is required');
assert(Date.now()-Date.parse(audit.completed_at)<86400000, 'Rerun the audit before repairing old evidence');
const compile=path=>ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const historyUrl=moduleUrl(compile('src/lib/messaging-auto-tag.ts'));
const {parseMessengerStageEvent}=await import(moduleUrl(compile('src/lib/messenger-stage-sync.ts').replaceAll('@/lib/messaging-auto-tag',historyUrl)));
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:15000,query_timeout:120000});
const apply=process.argv.includes('--apply'), result={applied:apply,events:[],tags_removed:0,customer_messages_sent:0,financial_records_created:0};
await db.connect();
try {
 await db.query('BEGIN');
 const configs=JSON.stringify((await db.query('SELECT * FROM chatbot_configs ORDER BY page_id')).rows);
 const affected=audit.profiles.filter(p=>p.missing_stage_events?.length);
 assert(affected.reduce((n,p)=>n+p.missing_stage_events.length,0)<=500,'Repair batch is too large');
 const ids=affected.map(p=>p.contact_id);
 const tagIds=()=>db.query('SELECT contact_id,tag_id FROM contact_tags WHERE contact_id=ANY($1::uuid[])',[ids]);
 const beforeTags=new Set((await tagIds()).rows.map(t=>t.contact_id+':'+t.tag_id));
 for(const profile of affected){
  assert(profile.meta_history.complete && profile.meta_history.exact_snapshot_match,'History must match Meta exactly');
  const page=audit.pages.find(p=>p.page===profile.page);
  assert(page?.access.readable,'Page access must be verified');
  const {rows:[current]}=await db.query(`SELECT c.page_id,p.fb_page_id,s.messenger_history_reset_at FROM contacts c JOIN pages p ON p.id=c.page_id
   LEFT JOIN chatbot_contact_states s ON s.page_id=c.page_id AND s.contact_id=c.id WHERE c.id=$1 FOR UPDATE OF c`,[profile.contact_id]);
  assert.equal(current.page_id,page.page_id);
  for(const event of profile.missing_stage_events.slice().sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt))){
   const {rows:[source]}=await db.query(`SELECT message_id,text,sent_at,sender FROM contact_profile_messages
    WHERE page_id=$1 AND contact_id=$2 AND generation=$3 AND message_id=$4`,[current.page_id,profile.contact_id,profile.generation,event.messageId]);
   assert(source && source.sender==='page','Only saved Page-authored notices are authoritative');
   const parsed=parseMessengerStageEvent({id:source.message_id,message:source.text,created_time:source.sent_at,from:{id:current.fb_page_id}},current.fb_page_id,{historyResetAt:current.messenger_history_reset_at});
   assert.deepEqual(parsed,event,'Stage evidence or reset changed after the audit');
   const {rows:[saved]}=await db.query('SELECT apply_messenger_lead_stage($1,$2,$3,$4,$5,$6) AS result',
    [current.page_id,profile.contact_id,parsed.messageId,parsed.label,parsed.stage,parsed.occurredAt]);
   result.events.push({page:profile.page,label:parsed.label,occurred_at:parsed.occurredAt,...saved.result});
  }
 }
 const afterTags=new Set((await tagIds()).rows.map(t=>t.contact_id+':'+t.tag_id));
 assert([...beforeTags].every(key=>afterTags.has(key)),'Existing tag assignments must be retained');
 result.tags_added=[...afterTags].filter(key=>!beforeTags.has(key)).length;
 result.bot_configuration_preserved=configs===JSON.stringify((await db.query('SELECT * FROM chatbot_configs ORDER BY page_id')).rows);
 assert(result.bot_configuration_preserved,'Chatbot configuration changed during repair');
 await db.query(apply?'COMMIT':'ROLLBACK');
 fs.writeFileSync(dir+'/stage-history-repair.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
