// Read-only delivery audit. Prints counts and formatting features, no tokens or customer details.
import pg from 'pg';
import { isRepeatedChatbotCopy, splitConversationalCopy } from '../src/lib/chatbot-message-copy.ts';
const db = new pg.Client({ connectionString: process.argv.includes('--transaction-pooler') ? process.env.DATABASE_POOLER_URL_6543 : process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 12000, query_timeout: 20000, statement_timeout: 15000 });
await db.connect();
try {
    const pages = (await db.query(`SELECT p.id,p.name,p.fb_page_id,p.access_token,c.enabled,c.follow_up_enabled,
        c.split_messages,c.max_message_parts,c.commercial_video_intake_enabled,c.trial_mode_enabled,c.updated_at
        FROM pages p JOIN chatbot_configs c ON c.page_id=p.id WHERE p.name ILIKE '%Negosyo%' AND c.commercial_video_intake_enabled=true ORDER BY p.name`)).rows;
    for (const page of pages) {
        const { access_token, fb_page_id, ...config } = page;
        console.log(JSON.stringify({ config }));
        const recovery = (await db.query('SELECT enabled,checked_at,last_error,lease_until FROM chatbot_inbound_recovery_pages WHERE page_id=$1', [page.id])).rows;
        const recent = (await db.query(`SELECT r.status,r.error_message,r.created_at,r.updated_at,s.status AS contact_status,s.stop_reason,
            c.pipeline_stage,c.pipeline_stage_source FROM chatbot_reply_events r LEFT JOIN chatbot_contact_states s ON s.page_id=r.page_id AND s.contact_id=r.contact_id
            LEFT JOIN contacts c ON c.page_id=r.page_id AND c.id=r.contact_id WHERE r.page_id=$1 ORDER BY r.created_at DESC LIMIT 12`, [page.id])).rows;
        console.log(JSON.stringify({ page:page.name,recovery,recent }));
        const replies = (await db.query(`SELECT status,error_message,count(*)::integer AS count FROM chatbot_reply_events
            WHERE page_id=$1 AND created_at>now()-interval '24 hours' GROUP BY status,error_message ORDER BY count(*) DESC LIMIT 8`, [page.id])).rows;
        const bubbles = (await db.query(`SELECT source_name,count(*)::integer AS count FROM outbound_message_events
            WHERE page_id=$1 AND source_type='chatbot' AND sent_at>now()-interval '24 hours' GROUP BY source_name ORDER BY count(*) DESC LIMIT 12`, [page.id])).rows;
        const url = new URL(`https://graph.facebook.com/v21.0/${fb_page_id}/conversations`);
        url.searchParams.set('fields', 'id,messages.limit(25){id,message,from,created_time}');
        url.searchParams.set('limit', '5');
        const response = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(15000) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message || 'Messenger history unavailable');
        let pageMessages = 0, combinedSentences = 0, intactForms = 0, separatedFormQuestions = 0, repeatedInSameRun = 0, dashFormatting = 0;
        for (const thread of body.data || []) {
            const messages = [...(thread.messages?.data || [])].sort((a,b) => Date.parse(a.created_time)-Date.parse(b.created_time));
            console.log(JSON.stringify({ page:page.name,threadLatestAt:messages.at(-1)?.created_time,latestFrom:messages.at(-1)?.from?.id===fb_page_id?'page':'customer',messageCount:messages.length }));
            let previousRun = [];
            for (const [index, message] of messages.entries()) {
                if (message.from?.id !== fb_page_id) { previousRun = []; continue; }
                const text = message.message || '';
                pageMessages++;
                const form = /1\. Business Name:\s*\n2\. Business Location:\s*\n3\. Goal ng video:\s*\n4\. Contact Number:/.test(text);
                if (form) {
                    intactForms++;
                    if (messages[index+1]?.from?.id === fb_page_id && /\?/.test(messages[index+1]?.message || '')) separatedFormQuestions++;
                } else if (splitConversationalCopy(text).length > 1) combinedSentences++;
                if (/^\s*[-–—•]|\s[-–—]\s/m.test(text)) dashFormatting++;
                if (previousRun.some(old => isRepeatedChatbotCopy(text, old))) repeatedInSameRun++;
                previousRun.push(text);
            }
        }
        console.log(JSON.stringify({ page: page.name, replies, bubbles,
            messenger: { threads: body.data?.length || 0, pageMessages, combinedSentences, intactForms, separatedFormQuestions, repeatedInSameRun, dashFormatting } }));
    }
} finally { await db.end(); }
