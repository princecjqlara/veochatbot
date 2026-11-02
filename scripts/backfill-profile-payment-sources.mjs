import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import{createRequire}from'node:module';import{build}from'esbuild';import pg from'pg';
const apply=process.argv.includes('--apply');assert(apply||process.argv.includes('--preflight'),'Choose --preflight or --apply');
fs.mkdirSync('.vercel',{recursive:true});const output=path.resolve('.vercel/calendar-payment-runtime.cjs');
await build({entryPoints:['src/lib/contact-projection-refresh.ts'],outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const{projectionCacheFromMessages}=createRequire(import.meta.url)(output);
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},query_timeout:120000});
const receipt={applied:false,updated:0,skipped:0,payment_sources_found:0,financial_records_created:0,customer_messages_sent:0};
try{
 await db.connect();if(!apply)await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
 const invariant=async()=>(await db.query("SELECT (SELECT count(*) FROM contact_tags)::int AS tags,(SELECT count(*) FROM contact_verified_payments)::int AS receipts,(SELECT count(*) FROM ad_daily_spend)::int AS spend,(SELECT md5(string_agg(to_jsonb(c)::text,',' ORDER BY page_id)) FROM chatbot_configs c) AS bots")).rows[0];
 const before=await invariant();
 const snapshots=(await db.query("SELECT DISTINCT ON(s.contact_id) s.contact_id,s.page_id,s.generation,s.message_count,s.source_cutoff_at,c.psid,p.fb_page_id FROM contact_profile_snapshots s JOIN contacts c ON c.id=s.contact_id AND c.page_id=s.page_id JOIN pages p ON p.id=s.page_id WHERE s.payload->>'history_complete'='true' ORDER BY s.contact_id,s.generation DESC")).rows;
 for(const snapshot of snapshots){
  if(apply)await db.query('BEGIN');
  const previous=(await db.query('SELECT * FROM contact_conversion_cache WHERE page_id=$1 AND contact_id=$2'+(apply?' FOR UPDATE':''),[snapshot.page_id,snapshot.contact_id])).rows[0];
  if(previous&&Date.parse(previous.source_cutoff_at)>Date.parse(snapshot.source_cutoff_at)){if(apply)await db.query('COMMIT');receipt.skipped++;continue;}
  const messages=(await db.query('SELECT message_id,sent_at,sender,text FROM contact_profile_messages WHERE page_id=$1 AND contact_id=$2 AND generation=$3 ORDER BY sent_at,message_id',[snapshot.page_id,snapshot.contact_id,snapshot.generation])).rows;
  assert.equal(messages.length,snapshot.message_count,'Stored complete history must match its checkpoint');
  const raw=messages.map(m=>({id:m.message_id,created_time:new Date(m.sent_at).toISOString(),message:m.text,from:{id:m.sender==='customer'?snapshot.psid:m.sender==='page'?snapshot.fb_page_id:'unknown'}}));
  const cache=projectionCacheFromMessages(raw,{contactId:snapshot.contact_id,pageId:snapshot.page_id,facebookPageId:snapshot.fb_page_id,psid:snapshot.psid,cutoff:Date.parse(snapshot.source_cutoff_at),previous});
  if(!cache.complete_history){if(apply)await db.query('COMMIT');receipt.skipped++;continue;}
  const saved=(await db.query('SELECT save_contact_conversion_cache($1,$2,$3::jsonb) AS data',[snapshot.page_id,snapshot.contact_id,JSON.stringify(cache)])).rows[0].data;
  assert(saved,'Payment source checkpoint failed');if(apply)await db.query('COMMIT');receipt.updated++;if(cache.payment_at)receipt.payment_sources_found++;
 }
 if(!apply){assert.deepEqual(await invariant(),before);await db.query('ROLLBACK');}receipt.applied=apply;receipt.passed=true;
}catch(e){await db.query('ROLLBACK').catch(()=>{});receipt.applied=apply&&receipt.updated>0;receipt.passed=false;receipt.error=e.message;process.exitCode=1;}
finally{await db.end();fs.writeFileSync('.vercel/profile-payment-backfill-'+(apply?'apply':'preflight')+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
