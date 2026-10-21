// Read-only runtime check. Never signs or replays a customer webhook.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const pageId = 'b33a9b46-6470-48ed-bcfc-4235aa46f241';
const contactId = '5dc31f3d-29db-440d-93cd-0b76c7bfb6d9';
const checked = result => { if (result.error) throw new Error(result.error.message); return result.data; };
const page = checked(await db.from('pages').select('fb_page_id,access_token').eq('id', pageId).single());
const config = checked(await db.from('chatbot_configs').select('enabled,split_messages,max_message_parts,policy_revision').eq('page_id', pageId).single());
const recovery = checked(await db.from('chatbot_inbound_recovery_pages').select('*').eq('page_id', pageId).maybeSingle());
const contact = checked(await db.from('contacts').select('psid').eq('id', contactId).eq('page_id', pageId).single());
const state = checked(await db.from('chatbot_contact_states').select('status,stop_reason,pause_kind,last_inbound_at,last_bot_reply_at,messenger_history_reset_at')
    .eq('page_id', pageId).eq('contact_id', contactId).maybeSingle());
const response = await fetch(`https://graph.facebook.com/v24.0/${page.fb_page_id}/conversations?user_id=${encodeURIComponent(contact.psid)}&fields=id,messages.limit(10){id,message,from,created_time}&limit=1`,
    { headers: { Authorization: `Bearer ${page.access_token}` }, signal: AbortSignal.timeout(15000) });
const body = await response.json();
assert.ok(response.ok && !body.error, body.error?.message || 'Messenger history unavailable');
const messages = body.data?.[0]?.messages?.data || [];
const inbound = messages.find(message => message.from?.id === contact.psid);
const reply = inbound ? checked(await db.from('chatbot_reply_events').select('status,outbound_message_id,error_message,created_at,updated_at')
    .eq('page_id', pageId).eq('inbound_message_id', inbound.id).maybeSingle()) : null;
const event = inbound ? checked(await db.from('chatbot_inbound_recovery_events').select('status,attempt_count,error_message,updated_at')
    .eq('page_id', pageId).eq('message_id', inbound.id).maybeSingle()) : null;
const freshInbound = Boolean(recovery && inbound && Date.parse(inbound.created_time) >= Date.parse(recovery.enabled_at));
const actualReplyVisible = Boolean(reply?.outbound_message_id && messages.some(message => message.id === reply.outbound_message_id));
const report = { at: new Date().toISOString(), config, recovery, state,
    inbound: inbound ? { id: inbound.id, at: inbound.created_time, text: inbound.message } : null,
    reply, recoveryEvent: event, freshInbound, actualReplyVisible,
    endToEndPassed: freshInbound && reply?.status === 'sent' && actualReplyVisible,
    latestMessages: messages.slice(0, 5).map(message => ({ from: message.from?.id === page.fb_page_id ? 'page' : 'customer', at: message.created_time, text: message.message })) };
await writeFile(new URL('../../data/manawari-recovery-runtime-check.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (process.argv.includes('--require-fresh')) assert.ok(report.endToEndPassed, 'A new actual Messenger inquiry and matching delivered reply are required for end-to-end proof');
