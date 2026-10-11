// Read-only by default. --apply saves verified stops and cancels queued chatbot
// follow-ups; it never calls a Messenger send endpoint. Run with Node 22+:
// node --experimental-strip-types --env-file=.env.local scripts/reconcile-messenger-handoffs.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { classifyMessengerHistoryMessage, loadMessengerHistoryForStopCheck } from '../src/lib/messaging-auto-tag.ts';
import { getChatbotContactState, saveChatbotContactState } from '../src/lib/chatbot-control.ts';
import { pipelineStageForMessengerSignal, updateContactPipelineStage } from '../src/lib/contact-pipeline.ts';

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const apply = args.includes('--apply');
const maxThreads = args.includes('--max-threads') ? Number(value('--max-threads')) : 60;
if (!Number.isInteger(maxThreads) || maxThreads < 1 || maxThreads > 300) throw new Error('max-threads must be 1-300');
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase credentials are required');
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
let pageQuery = db.from('pages').select('id,name,fb_page_id,access_token');
pageQuery = args.includes('--page-id') ? pageQuery.eq('id', value('--page-id')) : pageQuery.eq('name', 'Onset Media Agency');
const { data: page, error: pageError } = await pageQuery.single();
if (pageError) throw new Error(pageError.message);
const folder = fileURLToPath(new URL('../../data/', import.meta.url));
await mkdir(folder, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(folder, `messenger-handoffs-${page.id}-${stamp}.json`);
const report = { checkedAt: new Date().toISOString(), mode: apply ? 'apply' : 'audit',
    page: { id: page.id, name: page.name }, checked: 0, stopped: 0, contacts: [], errors: [] };
let next = new URL(`https://graph.facebook.com/v21.0/${page.fb_page_id}/conversations`);
next.searchParams.set('fields', 'id,participants,messages.limit(100){id,message,from,created_time,tags}');
next.searchParams.set('limit', '5');
const seen = new Set();
try {
    while (next && report.checked < maxThreads) {
        if (next.protocol !== 'https:' || next.hostname !== 'graph.facebook.com') throw new Error('Unexpected Graph pagination URL');
        next.searchParams.delete('access_token');
        const response = await fetch(next, { cache: 'no-store', headers: { Authorization: `Bearer ${page.access_token}` },
            signal: AbortSignal.timeout(20000) });
        const body = await response.json();
        if (!response.ok || !Array.isArray(body.data)) throw new Error(body.error?.message || 'Messenger history unavailable');
        for (const thread of body.data) {
            if (report.checked >= maxThreads) break;
            const psid = thread.participants?.data?.find(person => person.id !== page.fb_page_id)?.id;
            if (!psid || seen.has(psid)) continue;
            seen.add(psid);
            report.checked++;
            const { data: contact, error } = await db.from('contacts').select('id,pipeline_stage,pipeline_stage_source')
                .eq('page_id', page.id).eq('psid', psid).maybeSingle();
            if (error) throw new Error(error.message);
            if (!contact) continue;
            const state = await getChatbotContactState(db, page.id, contact.id);
            if (state?.status !== 'active') continue;
            try {
                const history = await loadMessengerHistoryForStopCheck({ facebookPageId: page.fb_page_id,
                    accessToken: page.access_token, initialPage: thread.messages, requireAvailable: true,
                    humanHandoffSince: state.started_at });
                const handoff = history.find(message => classifyMessengerHistoryMessage(message, page.fb_page_id, { humanHandoffSince: state.started_at }));
                if (!handoff) continue;
                const signal = classifyMessengerHistoryMessage(handoff, page.fb_page_id, { humanHandoffSince: state.started_at });
                // Verify that mobile provenance is not attached to one of our API sends.
                if (handoff.tags?.data?.some(tag => tag.name === 'source:mobile')) {
                    const { data: known, error: knownError } = await db.from('outbound_message_events')
                        .select('source_type').eq('page_id', page.id).eq('message_id', handoff.id).maybeSingle();
                    if (knownError) throw new Error(knownError.message);
                    if (known && known.source_type !== 'manual') throw new Error('Mobile provenance conflicts with API message attribution');
                }
                const item = { contactId: contact.id, stage: contact.pipeline_stage, source: contact.pipeline_stage_source,
                    signal, messageId: handoff.id, handoffAt: handoff.created_time, applied: false };
                report.contacts.push(item);
                if (apply) {
                    const freshState = await getChatbotContactState(db, page.id, contact.id);
                    if (freshState?.status !== 'active') continue;
                    const { data: jobs, error: jobsError } = await db.from('chatbot_follow_up_jobs').select('*')
                        .eq('page_id', page.id).eq('contact_id', contact.id).in('status', ['pending', 'processing', 'ready_manual']);
                    if (jobsError) throw new Error(jobsError.message);
                    const backupPath = path.join(folder, `messenger-handoff-backup-${contact.id}-${stamp}.json`);
                    await writeFile(backupPath, JSON.stringify({ pageId: page.id, contact, state: freshState, jobs }, null, 2));
                    await saveChatbotContactState(db, { pageId: page.id, contactId: contact.id, existingState: freshState, stopReason: signal });
                    const { error: cancelError } = await db.from('chatbot_follow_up_jobs')
                        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), claimed_at: null,
                            error_message: `Verified Messenger handoff: ${signal}` })
                        .eq('page_id', page.id).eq('contact_id', contact.id).in('status', ['pending', 'processing', 'ready_manual']);
                    if (cancelError) throw new Error(cancelError.message);
                    await updateContactPipelineStage(db, { pageId: page.id, contactId: contact.id,
                        stage: pipelineStageForMessengerSignal(signal), source: 'messenger' });
                    item.applied = true;
                    item.cancelledJobs = jobs.length;
                    report.stopped++;
                }
            } catch (error) {
                report.errors.push({ contactId: contact.id, error: error.message });
            }
        }
        next = body.paging?.next ? new URL(body.paging.next) : null;
    }
} finally {
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ page: page.name, mode: report.mode, checked: report.checked,
        handoffs: report.contacts.length, stopped: report.stopped, errors: report.errors, reportPath }));
}
if (report.errors.length) process.exitCode = 1;
