import { createClient } from '@supabase/supabase-js';
import { readFile, writeFile } from 'node:fs/promises';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const originals = JSON.parse(await readFile('../data/chatbot-settings-before-short-replies.json', 'utf8'));
if (!Array.isArray(originals) || originals.length !== 2) throw new Error('Original follow-up settings backup is invalid');
const restoreTime = new Date().toISOString();
const summary = [];
for (const original of originals) {
    const current = await db.from('chatbot_configs').select('*').eq('page_id', original.page_id).single();
    if (current.error) throw current.error;
    await writeFile(`../data/chatbot-follow-up-restore-before-${original.page_id}.json`, JSON.stringify(current.data, null, 2), { flag: 'wx' })
        .catch(error => { if (error.code !== 'EEXIST') throw error; });
    const patch = Object.fromEntries(Object.entries(original).filter(([key]) => key.startsWith('follow_up_') || ['split_messages', 'max_message_parts'].includes(key)));
    const updated = await db.from('chatbot_configs').update({ ...patch, updated_at: restoreTime })
        .eq('page_id', original.page_id).eq('updated_at', current.data.updated_at).select('page_id');
    if (updated.error) throw updated.error;
    if (!updated.data?.length) throw new Error('Settings changed concurrently; restoration stopped');
    const verified = await db.from('chatbot_configs').select('*').eq('page_id', original.page_id).single();
    if (verified.error) throw verified.error;
    for (const [key, value] of Object.entries(patch)) {
        if (JSON.stringify(verified.data[key]) !== JSON.stringify(value)) throw new Error(`Restored setting verification failed: ${key}`);
    }
    // Restore eligible future reminders cancelled by our previous change.
    // Do not release an overdue backlog or reopen stopped/handoff contacts.
    const jobsResult = await db.from('chatbot_follow_up_jobs').select('id,contact_id,anchor_inbound_at,due_at')
        .eq('page_id', original.page_id).eq('status', 'cancelled')
        .eq('error_message', 'Cancelled to reduce repetitive chatbot follow-ups').gte('due_at', restoreTime).limit(1000);
    if (jobsResult.error) throw jobsResult.error;
    let restoredJobs = 0;
    const contactIds = [...new Set((jobsResult.data || []).map(job => job.contact_id))];
    const contacts = new Map();
    const states = new Map();
    for (let offset = 0; offset < contactIds.length; offset += 100) {
        const ids = contactIds.slice(offset, offset + 100);
        const [contactRows, stateRows] = await Promise.all([
            db.from('contacts').select('id,pipeline_stage,last_inbound_at,last_interaction_at').eq('page_id', original.page_id).in('id', ids),
            db.from('chatbot_contact_states').select('contact_id,status').eq('page_id', original.page_id).in('contact_id', ids)
        ]);
        if (contactRows.error || stateRows.error) throw contactRows.error || stateRows.error;
        for (const row of contactRows.data || []) contacts.set(row.id, row);
        for (const row of stateRows.data || []) states.set(row.contact_id, row);
    }
    const eligibleIds = (jobsResult.data || []).filter(job => {
        const contact = contacts.get(job.contact_id);
        return original.follow_up_enabled && contact && states.get(job.contact_id)?.status !== 'stopped' &&
            !['qualified', 'not_qualified', 'converted', 'order_created', 'opted_out'].includes(contact.pipeline_stage) &&
            new Date(contact.last_inbound_at || contact.last_interaction_at || 0).getTime() <= new Date(job.anchor_inbound_at).getTime();
    }).map(job => job.id);
    for (let offset = 0; offset < eligibleIds.length; offset += 100) {
        const restored = await db.from('chatbot_follow_up_jobs').update({ status: 'pending', cancelled_at: null, claimed_at: null, error_message: null, updated_at: restoreTime }, { count: 'exact' })
            .eq('page_id', original.page_id).in('id', eligibleIds.slice(offset, offset + 100)).eq('status', 'cancelled')
            .eq('error_message', 'Cancelled to reduce repetitive chatbot follow-ups').gte('due_at', new Date().toISOString());
        if (restored.error) throw restored.error;
        restoredJobs += restored.count || 0;
    }
    const result = { pageId: original.page_id, quickMinutes: verified.data.follow_up_quick_delays_minutes,
        bestTimeDays: verified.data.follow_up_best_time_days, allOriginalFollowUpFieldsVerified: true, restoredFutureJobs: restoredJobs };
    summary.push(result);
    console.log(JSON.stringify(result));
}
await writeFile('../data/chatbot-follow-up-restore-result.json', JSON.stringify({ restoredAt: restoreTime, pages: summary }, null, 2));
