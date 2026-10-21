// Observe the normal production worker. This script does not dispatch or send messages.
import pg from 'pg';
import {writeFile} from 'node:fs/promises';
const pageId='776b33f3-e492-43bd-a887-d451d7faa5a8';
const start=Date.now(), deadline=start+4*60000;
const db=new pg.Client({connectionString:process.env.DATABASE_POOLER_URL_6543,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,query_timeout:15000});
await db.connect();
let previous='';
try {
    while(Date.now()<deadline){
        const reply=(await db.query('SELECT status,error_message,outbound_message_id,created_at,updated_at FROM chatbot_reply_events WHERE page_id=$1 ORDER BY created_at DESC LIMIT 1',[pageId])).rows[0];
        const worker=(await db.query('SELECT checked_at,last_error,lease_until FROM chatbot_inbound_recovery_pages WHERE page_id=$1',[pageId])).rows[0];
        const snapshot={page:'Commercial sa Negosyo Media',replyStatus:reply?.status,error:reply?.error_message,hasOutbound:Boolean(reply?.outbound_message_id),replyUpdatedAt:reply?.updated_at,worker};
        const serialized=JSON.stringify(snapshot);
        if(serialized!==previous){console.log(serialized);previous=serialized;}
        if(reply?.status==='sent'&&reply.outbound_message_id){
            await writeFile(new URL('../../data/negosyo-reply-recovery.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),...snapshot,verified:true,messagesSentByWatcher:0},null,2));
            break;
        }
        if(reply?.status==='failed'&&Date.parse(reply.updated_at)>start)throw new Error(reply.error_message||'Production recovery failed again');
        await new Promise(resolve=>setTimeout(resolve,10000));
    }
} finally {await db.end();}
