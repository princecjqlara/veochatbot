import { getPageConversationsBatch } from '@/lib/facebook';
import {
    classifyMessengerHistoryMessage,
    findLatestMessengerSystemSignal,
    findLatestMessengerLeadStageEvent,
    getMessengerHandoffMetadata,
    type MessengerSystemSignal,
    type MessengerHistoryMessage
} from '@/lib/messaging-auto-tag';
import {
    getChatbotContactState,
    getChatbotHandoffOptions,
    saveChatbotContactState
} from '@/lib/chatbot-control';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
    pipelineStageForMessengerSignal,
    updateContactPipelineStage
} from '@/lib/contact-pipeline';
import { recordChatbotInterruptionIfNeeded } from '@/lib/outbound-message-events';
import { choosePositiveOutcomeTag, ensureMessengerOutcomeTags } from '@/lib/messenger-outcome-tags';
import { ensureChatbotPageWebhook, repairSavedMessengerOutcomeTags } from '@/lib/chatbot-page-maintenance';
export { MESSENGER_OUTCOME_TAGS, buildMessengerOutcomeTagRows, choosePositiveOutcomeTag } from '@/lib/messenger-outcome-tags';

type Page = {
    id: string;
    fb_page_id: string;
    access_token: string;
    messaging_auto_tag_checked_at: string;
    messaging_auto_tag_cursor: string | null;
    messaging_auto_tag_scan_started_at?: string | null;
};

type Message = MessengerHistoryMessage & { id: string; created_time: string };

type DefaultPageTag = {
    id: string;
    name: string;
    created_at?: string | null;
};

type MessengerOutcomeTag = {
    id: string;
    system_key: MessengerSystemSignal;
};

async function getMessagesSince(conversationId: string, token: string, since: string): Promise<Message[]> {
    let next: string | null = `https://graph.facebook.com/v21.0/${encodeURIComponent(conversationId)}/messages?fields=id,message,from,created_time,tags&limit=100`;
    const messages: Message[] = [];
    const seen = new Set<string>();

    for (let page = 0; next && page < 10; page++) {
        const url: URL = new URL(next);
        if (url.hostname !== 'graph.facebook.com' || seen.has(next)) throw new Error('Unexpected Messenger pagination URL');
        seen.add(next);
        url.searchParams.delete('access_token');
        const response: Response = await fetch(url, {
            cache: 'no-store',
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15_000)
        });
        const body: { data?: Message[]; paging?: { next?: string }; error?: { message?: string } } = await response.json();
        if (!response.ok || body.error) throw new Error(body.error?.message || `Messenger history HTTP ${response.status}`);
        const rows = body.data || [];
        messages.push(...rows.filter(message => new Date(message.created_time).getTime() >= new Date(since).getTime()));
        if (rows.some(message => new Date(message.created_time).getTime() < new Date(since).getTime())) return messages;
        next = body.paging?.next || null;
    }
    if (next) throw new Error('Messenger history exceeded the safe per-conversation limit');
    return messages;
}

export async function processOneMessagingAutoTagPage(input: { chatbotOnly?: boolean; pageId?: string } = {}) {
    const db = getSupabaseAdmin();
    const fields = input.chatbotOnly
        ? 'id,fb_page_id,access_token,messaging_auto_tag_checked_at,messaging_auto_tag_cursor,messaging_auto_tag_scan_started_at,chatbot_configs!chatbot_configs_page_id_fkey!inner(enabled)'
        : 'id,fb_page_id,access_token,messaging_auto_tag_checked_at,messaging_auto_tag_cursor,messaging_auto_tag_scan_started_at';
    let pageQuery = db.from('pages')
        .select<typeof fields, Page>(fields)
        .eq('messaging_auto_tag_enabled', true);
    if (input.chatbotOnly) pageQuery = pageQuery.eq('chatbot_configs.enabled', true);
    if (input.pageId) pageQuery = pageQuery.eq('id', input.pageId);
    const { data: page, error: pageError } = await pageQuery
        .order('messaging_auto_tag_attempted_at', { ascending: true })
        .limit(1).maybeSingle();
    if (pageError) throw pageError;
    if (!page) return { pages: 0, conversations: 0, tagged: 0, pipelineMoved: 0 };
    const current = page as Page;
    const runStartedAt = new Date().toISOString();
    // Existing cursors from before this migration conservatively repeat the old
    // interval once instead of skipping edits made during their unfinished scan.
    const scanStartedAt = current.messaging_auto_tag_scan_started_at ||
        (current.messaging_auto_tag_cursor ? current.messaging_auto_tag_checked_at : runStartedAt);
    const maintenanceErrors: string[] = [];
    let webhookHealth: { verified: boolean; repaired: boolean } | { error: string } | null = null;
    let repairedOutcomeTags = 0;

    try {
        if (input.chatbotOnly) {
            try {
                webhookHealth = await ensureChatbotPageWebhook({ facebookPageId: current.fb_page_id, accessToken: current.access_token });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                webhookHealth = { error: message };
                maintenanceErrors.push(`Webhook: ${message}`);
                console.warn('Webhook subscription maintenance failed; lead-stage stops will still run', { pageId: current.id, message });
            }
        }
        const { data: defaultTags, error: tagError } = await db.from('tags')
            .select('id,name,created_at')
            .eq('owner_type', 'page')
            .eq('owner_id', current.id)
            .eq('is_default', true)
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .limit(25);
        if (tagError) console.warn('Could not load default Page tags; lead-stage stops will still run', tagError.message);
        const tag = choosePositiveOutcomeTag((defaultTags || []) as DefaultPageTag[]);
        if (!tag) console.warn('Default Page tag is missing; lead-stage stops will still run', { pageId: current.id });
        if ((defaultTags || []).length > 1) {
            console.warn('Multiple default Page tags found; using the Paid / Availed Service tag', {
                pageId: current.id,
                count: defaultTags?.length,
                selectedTagId: tag?.id
            });
        }

        let rawOutcomeTags: MessengerOutcomeTag[] = [];
        try {
            rawOutcomeTags = await ensureMessengerOutcomeTags(db, current.id);
        } catch (error) {
            console.warn('Could not create outcome tags; lead-stage stops will still run', error);
            maintenanceErrors.push('Outcome tag definitions need retry');
        }
        const outcomeTagIds = new Map(
            rawOutcomeTags.map(outcomeTag => [
                outcomeTag.system_key,
                outcomeTag.id
            ])
        );

        if (input.chatbotOnly) {
            try { repairedOutcomeTags = await repairSavedMessengerOutcomeTags(db, current.id); }
            catch (error) {
                maintenanceErrors.push(`Outcome tag recovery: ${error instanceof Error ? error.message : String(error)}`);
                console.warn('Saved outcome tags need retry; lead-stage stops will still run', { pageId: current.id, error });
            }
        }

        const batch = await getPageConversationsBatch(current.fb_page_id, current.access_token, {
            limit: 10,
            after: current.messaging_auto_tag_cursor,
            sinceTimestamp: current.messaging_auto_tag_checked_at
        });
        let tagged = 0;
        let chatbotStopped = 0;
        let pipelineMoved = 0;
        for (const conversation of batch.conversations) {
            const participant = conversation.participants?.data?.find(p => p.id !== current.fb_page_id);
            if (!participant) continue;
            const messages = await getMessagesSince(conversation.id, current.access_token, current.messaging_auto_tag_checked_at);
            let signals = [...new Set(messages
                .map(message => classifyMessengerHistoryMessage(message, current.fb_page_id))
                .filter((signal): signal is MessengerSystemSignal => signal !== null))];
            if (signals.length === 0) continue;

            let { data: contact, error: contactError } = await db.from('contacts').select('id,last_inbound_at')
                .eq('page_id', current.id).eq('psid', participant.id).maybeSingle();
            if (contactError) throw contactError;
            if (!contact) {
                const inserted = await db.from('contacts').insert({
                    page_id: current.id,
                    psid: participant.id,
                    name: participant.name?.trim() || null
                }).select('id,last_inbound_at').single();
                if (inserted.error) {
                    // Another worker may have created the contact first.
                    const found = await db.from('contacts').select('id,last_inbound_at')
                        .eq('page_id', current.id).eq('psid', participant.id).single();
                    if (found.error) throw inserted.error;
                    contact = found.data;
                } else {
                    contact = inserted.data;
                }
            }

            // Stop first. Optional tags and interruption logs must never gate
            // the durable stop or let a queued follow-up continue.
            const existingState = await getChatbotContactState(db, current.id, contact.id);
            const handoffOptions = getChatbotHandoffOptions(existingState, contact.last_inbound_at || runStartedAt);
            signals = [...new Set(messages
                .map(message => classifyMessengerHistoryMessage(message, current.fb_page_id, handoffOptions))
                .filter((signal): signal is MessengerSystemSignal => signal !== null))];
            if (signals.length === 0) continue;
            const stopSignal = findLatestMessengerSystemSignal(messages, current.fb_page_id, handoffOptions);
            if (stopSignal) {
                const handoffMetadata = getMessengerHandoffMetadata(messages, current.fb_page_id, handoffOptions);
                if (existingState?.status !== 'stopped' || existingState.stop_reason !== stopSignal ||
                    (handoffMetadata.humanActivityAt && Date.parse(handoffMetadata.humanActivityAt) > (Date.parse(existingState.last_human_activity_at || '') || 0))) {
                    await saveChatbotContactState(db, {
                        pageId: current.id, contactId: contact.id, existingState,
                        stopReason: stopSignal,
                        ...handoffMetadata
                    });
                    chatbotStopped++;
                }
                const { error: cancelError } = await db.from('chatbot_follow_up_jobs')
                    .update({ status: 'cancelled', cancelled_at: runStartedAt, claimed_at: null, updated_at: runStartedAt })
                    .eq('page_id', current.id).eq('contact_id', contact.id)
                    .in('status', ['pending', 'processing', 'ready_manual']);
                if (cancelError) throw cancelError;
                if (await updateContactPipelineStage(db, {
                    pageId: current.id, contactId: contact.id,
                    stage: pipelineStageForMessengerSignal(stopSignal), source: 'messenger'
                })) pipelineMoved++;
            }

            try {
                const leadStageEvent = findLatestMessengerLeadStageEvent(messages, current.fb_page_id, handoffOptions);
                if (leadStageEvent) {
                    await recordChatbotInterruptionIfNeeded(db, {
                        pageId: current.id,
                        contactId: contact.id,
                        messageId: leadStageEvent.messageId,
                        source: 'business_suite',
                        interruptionType: 'lead_stage_change',
                        leadStage: leadStageEvent.signal === 'manual'
                            ? null : pipelineStageForMessengerSignal(leadStageEvent.signal),
                        interruptedAt: leadStageEvent.createdTime || undefined,
                        stateBeforeStop: existingState
                    });
                }
                if (tag && signals.some(signal => signal !== 'not_qualified' && signal !== 'manual')) {
                    const { error: assignError } = await db.from('contact_tags').upsert({
                        contact_id: contact.id,
                        tag_id: tag.id
                    }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
                    if (assignError) throw assignError;
                    tagged++;
                }
                const outcomeAssignments = signals.flatMap(signal => {
                    const tagId = outcomeTagIds.get(signal);
                    return tagId ? [{ contact_id: contact.id, tag_id: tagId }] : [];
                });
                if (outcomeAssignments.length > 0) {
                    const { error: outcomeAssignError } = await db.from('contact_tags').upsert(
                        outcomeAssignments,
                        { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
                    );
                    if (outcomeAssignError) throw outcomeAssignError;
                    tagged += outcomeAssignments.length;
                }

            } catch (error) {
                maintenanceErrors.push('Lead-stage tagging or audit needs retry');
                console.warn('Lead-stage stop saved but optional tagging or audit failed', {
                    pageId: current.id, contactId: contact.id, error
                });
            }
        }

        let checkpoint = db.from('pages').update({
            messaging_auto_tag_checked_at: batch.nextCursor ? current.messaging_auto_tag_checked_at : scanStartedAt,
            messaging_auto_tag_cursor: batch.nextCursor,
            messaging_auto_tag_scan_started_at: batch.nextCursor ? scanStartedAt : null,
            messaging_auto_tag_attempted_at: runStartedAt,
            messaging_auto_tag_last_error: maintenanceErrors.length ? maintenanceErrors.join('; ').slice(0, 500) : null
        }).eq('id', current.id).eq('messaging_auto_tag_checked_at', current.messaging_auto_tag_checked_at);
        // An overlapping worker must not replace a newer pagination checkpoint.
        checkpoint = current.messaging_auto_tag_cursor
            ? checkpoint.eq('messaging_auto_tag_cursor', current.messaging_auto_tag_cursor)
            : checkpoint.is('messaging_auto_tag_cursor', null);
        const { error: checkpointError } = await checkpoint;
        if (checkpointError) throw checkpointError;
        return {
            pages: 1,
            conversations: batch.conversations.length,
            tagged,
            chatbotStopped,
            pipelineMoved,
            webhookHealth,
            repairedOutcomeTags,
            more: Boolean(batch.nextCursor)
        };
    } catch (error) {
        await db.from('pages').update({
            messaging_auto_tag_attempted_at: runStartedAt,
            messaging_auto_tag_last_error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown error'
        }).eq('id', current.id);
        throw error;
    }
}
