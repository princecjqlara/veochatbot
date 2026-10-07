import { createClient } from '@supabase/supabase-js';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const queries = [
  ['configs', db.from('chatbot_configs').select('page_id,enabled,trial_mode_enabled,stop_when_details_collected,details_completion_percent,details_to_collect,stop_on_opt_out,stop_on_refusal,follow_up_enabled')],
  ['pages', db.from('pages').select('id,name,fb_page_id,messaging_auto_tag_last_error,messaging_auto_tag_checked_at,messaging_auto_tag_attempted_at').in('name', ['Onset Media Agency', 'Azshinari'])],
  ['replies', db.from('chatbot_reply_events').select('page_id,contact_id,status,error_message,created_at').order('created_at', { ascending: false }).limit(250)],
  ['stops', db.from('chatbot_contact_states').select('page_id,status,stop_reason,updated_at').order('updated_at', { ascending: false }).limit(250)]
];
for (const [label, query] of queries) {
  const { data, error } = await query;
  if (label === 'replies' || label === 'stops') {
    const groups = {};
    for (const row of data || []) {
      const key = [row.page_id, row.status, row.error_message || row.stop_reason || ''].join('|');
      groups[key] = (groups[key] || 0) + 1;
    }
    console.log(label, JSON.stringify({ error, groups, latest: data?.[0]?.created_at || data?.[0]?.updated_at }));
  } else console.log(label, JSON.stringify({ error, data }));
}
const { data: configs } = await db.from('chatbot_configs').select('page_id').eq('enabled', true);
for (const config of configs || []) {
  const { data: page } = await db.from('pages').select('id,name,fb_page_id,access_token').eq('id', config.page_id).single();
  const url = new URL(`https://graph.facebook.com/v21.0/${page.fb_page_id}/conversations`);
  url.searchParams.set('fields', 'id,participants,updated_time,messages.limit(100){id,message,from,created_time}');
  url.searchParams.set('limit', '20');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${page.access_token}` }, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (!response.ok) { console.log('history error', page.name, body.error?.message); continue; }
  for (const thread of body.data || []) {
    const psid = thread.participants?.data?.find(p => p.id !== page.fb_page_id)?.id;
    const { data: contact } = await db.from('contacts').select('id,pipeline_stage,pipeline_stage_source,last_inbound_at').eq('page_id', page.id).eq('psid', psid).maybeSingle();
    const { data: state } = contact ? await db.from('chatbot_contact_states').select('status,stop_reason,last_bot_reply_at').eq('page_id', page.id).eq('contact_id', contact.id).maybeSingle() : { data: null };
    const messages = thread.messages?.data || [];
    const stageMessages = messages.filter(m => /lead stage|created an order/i.test(m.message || ''));
    console.log('thread', JSON.stringify({ page: page.name, contact: contact?.id, stage: contact?.pipeline_stage, source: contact?.pipeline_stage_source, state, newest: messages[0]?.created_time, newestFrom: messages[0]?.from?.id === page.fb_page_id ? 'page' : 'customer', count: messages.length, paginated: !!thread.messages?.paging?.next, stageMessages: stageMessages.map(m => ({ text: m.message, fromPage: m.from?.id === page.fb_page_id, time: m.created_time })) }));
  }
}
