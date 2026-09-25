import { getConversationForPsid, sendMessage, sendMessengerGenericCarousel } from '@/lib/facebook';
import {
    createChatbotMediaPublicViewUrl,
    createChatbotMediaSignedUrl,
    getReadyChatbotMediaForDocuments,
    type ChatbotMediaAsset
} from '@/lib/chatbot-media';
import { recordOutboundMessageEvent } from '@/lib/outbound-message-events';
import { getPhilippinesDateParts, getPhilippinesScheduledAtIso } from '@/lib/philippines-time';
import { replaceTemplateVariables } from '@/lib/placeholders';
import { getSupabaseAdmin } from '@/lib/supabase';
import { generateChatbotFollowUp, type ChatbotConfig } from '@/lib/chatbot';
import { getReadyChatbotDriveFilesForDocuments, getReadyChatbotDriveFolderForDocument, type ChatbotDriveFile, type ChatbotDriveFolder } from '@/lib/chatbot-drive-folders';
import { isPipelineClosedForAutomation, type ContactPipelineStage } from '@/lib/contact-pipeline';

const RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const HUMAN_AGENT_WINDOW_MS = 7 * RESPONSE_WINDOW_MS;
const RESPONSE_SAFETY_MS = 60 * 1000;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

type SupabaseLike = { from: (table: string) => any };

type ScheduleContact = {
    id: string;
    page_id: string;
    psid: string;
    name?: string | null;
    best_contact_hour?: number | null;
    last_interaction_at?: string | null;
    last_inbound_at?: string | null;
    pipeline_stage?: ContactPipelineStage | null;
};

type FollowUpJob = {
    id: string;
    page_id: string;
    contact_id: string;
    anchor_inbound_at: string;
    schedule_type: 'response' | 'human_agent' | 'manual_human_agent';
    sequence_index: number;
    due_at: string;
    message_text: string;
    attempt_count: number;
    media_asset_id?: string | null;
};

export function normalizeQuickFollowUpDelays(value: unknown): number[] {
    return Array.from(new Set(
        (Array.isArray(value) ? value : [])
            .map((item) => Math.round(Number(item)))
            .filter((item) => Number.isFinite(item) && item >= 1 && item <= 1439)
    )).sort((a, b) => a - b).slice(0, 10);
}

export function normalizeBestTimeFollowUpDays(value: unknown): number[] {
    return Array.from(new Set(
        (Array.isArray(value) ? value : [])
            .map((item) => Math.round(Number(item)))
            .filter((item) => Number.isFinite(item) && item >= 2 && item <= 7)
    )).sort((a, b) => a - b).slice(0, 6);
}

export function normalizeFollowUpMessages(value: unknown): string[] {
    return (Array.isArray(value) ? value : [])
        .filter((message): message is string => typeof message === 'string')
        .map((message) => message.trim().slice(0, 500))
        .filter(Boolean)
        .slice(0, 10);
}

export function hasReadableCustomerConversationHistory(
    history: Array<{ from?: { id?: string | null } | null; message?: string | null }>,
    pageId: string
): boolean {
    return history.some((message) =>
        message.from?.id !== pageId &&
        typeof message.message === 'string' &&
        message.message.trim().length > 0
    );
}

export function getAutomatedFollowUpMessagingType(
    scheduleType: FollowUpJob['schedule_type'],
    anchorInboundAt: string,
    now: Date = new Date()
): 'RESPONSE' | 'HUMAN_AGENT' | null {
    const elapsed = now.getTime() - new Date(anchorInboundAt).getTime();
    if (!Number.isFinite(elapsed) || elapsed < 0) return null;
    if (scheduleType === 'response') {
        return elapsed < RESPONSE_WINDOW_MS - RESPONSE_SAFETY_MS ? 'RESPONSE' : null;
    }
    if (scheduleType === 'human_agent') {
        return elapsed < HUMAN_AGENT_WINDOW_MS - RESPONSE_SAFETY_MS ? 'HUMAN_AGENT' : null;
    }
    return null;
}

export function getBestTimeFollowUpDueAt(anchor: Date, dayNumber: number, bestHour: number | null | undefined): string {
    const base = getPhilippinesDateParts(anchor);
    const target = new Date(Date.UTC(base.year, base.month, base.day + Math.max(1, dayNumber - 1)));
    const hour = Number.isInteger(bestHour) && Number(bestHour) >= 0 && Number(bestHour) <= 23
        ? Number(bestHour)
        : 12;
    return getPhilippinesScheduledAtIso(hour, {
        year: target.getUTCFullYear(),
        month: target.getUTCMonth(),
        day: target.getUTCDate()
    });
}

export async function cancelPendingChatbotFollowUps(input: {
    supabase: SupabaseLike;
    pageId: string;
    contactId: string;
    reason?: string;
    now?: Date;
}) {
    const now = input.now || new Date();
    const { error } = await input.supabase
        .from('chatbot_follow_up_jobs')
        .update({
            status: 'cancelled',
            cancelled_at: now.toISOString(),
            error_message: input.reason || 'Customer replied',
            claimed_at: null,
            updated_at: now.toISOString()
        })
        .eq('page_id', input.pageId)
        .eq('contact_id', input.contactId)
        .in('status', ['pending', 'processing', 'ready_manual']);
    if (error) throw new Error(error.message || 'Could not cancel chatbot follow-ups');
}

export async function scheduleChatbotFollowUps(input: {
    supabase: SupabaseLike;
    pageId: string;
    contact: ScheduleContact;
    config: ChatbotConfig;
    anchorInboundAt: string;
    now?: Date;
}): Promise<number> {
    if (!input.config.follow_up_enabled) return 0;
    if (isPipelineClosedForAutomation(input.contact.pipeline_stage)) return 0;

    const now = input.now || new Date();
    const anchor = new Date(input.anchorInboundAt);
    if (!Number.isFinite(anchor.getTime())) return 0;
    await cancelPendingChatbotFollowUps({
        supabase: input.supabase,
        pageId: input.pageId,
        contactId: input.contact.id,
        reason: 'Replaced by a newer follow-up sequence',
        now
    });

    const quickJobs = normalizeQuickFollowUpDelays(input.config.follow_up_quick_delays_minutes)
        .map((delay, index) => ({
            page_id: input.pageId,
            contact_id: input.contact.id,
            anchor_inbound_at: input.anchorInboundAt,
            schedule_type: 'response',
            sequence_index: index,
            due_at: new Date(anchor.getTime() + delay * 60 * 1000).toISOString(),
            message_text: 'AI-generated from conversation at send time',
            status: 'pending'
        }));
    const bestTimeJobs = normalizeBestTimeFollowUpDays(input.config.follow_up_best_time_days)
        .map((day, index) => ({
            page_id: input.pageId,
            contact_id: input.contact.id,
            anchor_inbound_at: input.anchorInboundAt,
            schedule_type: 'human_agent',
            sequence_index: index,
            due_at: getBestTimeFollowUpDueAt(anchor, day, input.contact.best_contact_hour),
            message_text: 'AI-generated from conversation at send time',
            status: 'pending'
        }));
    const jobs = [...quickJobs, ...bestTimeJobs].filter((job) => new Date(job.due_at).getTime() > now.getTime());
    if (jobs.length === 0) return 0;
    const { error } = await input.supabase.from('chatbot_follow_up_jobs').upsert(jobs, {
        onConflict: 'contact_id,anchor_inbound_at,schedule_type,sequence_index'
    });
    if (error) throw new Error(error.message || 'Could not schedule chatbot follow-ups');
    return jobs.length;
}

async function markJob(
    supabase: SupabaseLike,
    jobId: string,
    payload: Record<string, unknown>
) {
    const { error } = await supabase
        .from('chatbot_follow_up_jobs')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', jobId);
    if (error) throw new Error(error.message || 'Could not update chatbot follow-up');
}

export async function processDueChatbotFollowUps(input: {
    supabase?: SupabaseLike;
    now?: Date;
    limit?: number;
} = {}) {
    const supabase = input.supabase || getSupabaseAdmin();
    const now = input.now || new Date();
    const limit = Math.min(50, Math.max(1, input.limit || 20));
    const result = { checked: 0, sent: 0, readyManual: 0, cancelled: 0, failed: 0, mediaSent: 0 };

    await supabase.from('chatbot_follow_up_jobs').update({
        status: 'pending',
        claimed_at: null,
        updated_at: now.toISOString()
    }).eq('status', 'processing').lt('claimed_at', new Date(now.getTime() - PROCESSING_LEASE_MS).toISOString());

    const { data, error } = await supabase
        .from('chatbot_follow_up_jobs')
        .select('id, page_id, contact_id, anchor_inbound_at, schedule_type, sequence_index, due_at, message_text, attempt_count, media_asset_id')
        .eq('status', 'pending')
        .lte('due_at', now.toISOString())
        .order('due_at', { ascending: true })
        .limit(limit);
    if (error) throw new Error(error.message || 'Could not load due chatbot follow-ups');
    const jobs = (data || []) as FollowUpJob[];
    result.checked = jobs.length;

    for (const job of jobs) {
        const { data: claimed, error: claimError } = await supabase
            .from('chatbot_follow_up_jobs')
            .update({ status: 'processing', claimed_at: now.toISOString(), updated_at: now.toISOString() })
            .eq('id', job.id)
            .eq('status', 'pending')
            .select('id')
            .maybeSingle();
        if (claimError || !claimed) continue;

        try {
            const [{ data: page }, { data: contact }, { data: config }, { data: state }] = await Promise.all([
                supabase.from('pages').select('id, name, fb_page_id, access_token').eq('id', job.page_id).maybeSingle(),
                supabase.from('contacts').select('id, page_id, psid, name, last_interaction_at, last_inbound_at, pipeline_stage').eq('id', job.contact_id).maybeSingle(),
                supabase.from('chatbot_configs').select('*').eq('page_id', job.page_id).maybeSingle(),
                supabase.from('chatbot_contact_states').select('status, collected_details, missing_details').eq('page_id', job.page_id).eq('contact_id', job.contact_id).maybeSingle()
            ]);
            const anchorTime = new Date(job.anchor_inbound_at).getTime();
            const latestInboundTime = new Date(contact?.last_inbound_at || contact?.last_interaction_at || 0).getTime();
            const messagingType = getAutomatedFollowUpMessagingType(
                job.schedule_type,
                job.anchor_inbound_at,
                now
            );
            if (!page?.access_token || !contact?.psid || !config?.enabled || !config?.follow_up_enabled ||
                state?.status === 'stopped' || isPipelineClosedForAutomation(contact?.pipeline_stage) ||
                latestInboundTime > anchorTime ||
                (!messagingType && job.schedule_type !== 'manual_human_agent')) {
                await markJob(supabase, job.id, {
                    status: 'cancelled',
                    cancelled_at: now.toISOString(),
                    claimed_at: null,
                    error_message: 'Follow-up no longer eligible'
                });
                result.cancelled += 1;
                continue;
            }

            let personalizedMessage = '';
            let selectedMediaItems: ChatbotMediaAsset[] = [];
            let selectedDriveFiles: ChatbotDriveFile[] = [];
            let selectedDriveFolder: ChatbotDriveFolder | null = null;
            const conversation = await getConversationForPsid(
                page.fb_page_id,
                contact.psid,
                page.access_token,
                { throwOnError: true, timeoutMs: 5000 }
            );
            const conversationHistory = conversation?.messages?.data || [];
            const hasCustomerMessage = hasReadableCustomerConversationHistory(
                conversationHistory,
                page.fb_page_id
            );
            if (!hasCustomerMessage) {
                throw new Error('Messenger conversation history is unavailable; personalized follow-up was not sent');
            }
            try {
                const generated = await generateChatbotFollowUp({
                    config: config as ChatbotConfig,
                    contactName: contact.name,
                    pageName: page.name,
                    pageId: page.fb_page_id,
                    history: conversationHistory,
                    collectedDetails: state?.collected_details || {},
                    missingDetails: state?.missing_details || [],
                    sequenceNumber: job.sequence_index + 1,
                    scheduleLabel: job.schedule_type === 'response' ? 'first 24 hours' : 'best-time day 2-7'
                });
                if (generated.generation_warning) {
                    throw new Error('AI could not create a validated personalized follow-up');
                }
                personalizedMessage = generated.message;
                const generatedMediaDocumentIds = generated.media_document_ids?.length
                    ? generated.media_document_ids
                    : generated.media_document_id
                        ? [generated.media_document_id]
                        : [];
                if (generatedMediaDocumentIds.length > 0) {
                    selectedMediaItems = await getReadyChatbotMediaForDocuments({
                        pageId: job.page_id,
                        documentIds: generatedMediaDocumentIds
                    });
                }
                if (generated.drive_file_document_ids?.length) {
                    selectedDriveFiles = await getReadyChatbotDriveFilesForDocuments({
                        pageId: job.page_id,
                        documentIds: generated.drive_file_document_ids
                    });
                }
                if (generated.link_document_id && selectedDriveFiles.length === 0 && job.schedule_type === 'response') {
                    selectedDriveFolder = await getReadyChatbotDriveFolderForDocument({
                        pageId: job.page_id,
                        documentId: generated.link_document_id
                    });
                }
            } catch (generationError) {
                console.warn('[CHATBOT_FOLLOW_UP] AI personalization failed; follow-up will not use a generic fallback', {
                    jobId: job.id,
                    error: (generationError as Error).message
                });
                throw new Error(`AI personalization failed: ${(generationError as Error).message}`);
            }

            const selectedMedia = selectedMediaItems[0] || null;

            if (job.schedule_type === 'manual_human_agent') {
                await markJob(supabase, job.id, {
                    status: 'ready_manual',
                    message_text: personalizedMessage,
                    media_asset_id: selectedMedia?.id || null,
                    claimed_at: null,
                    error_message: null
                });
                result.readyManual += 1;
                continue;
            }

            const placeholderContact = {
                id: contact.id,
                page_id: contact.page_id,
                psid: contact.psid,
                name: contact.name || null,
                last_interaction_at: contact.last_interaction_at || null
            };
            const message = replaceTemplateVariables(personalizedMessage, placeholderContact).trim();
            const sendResult = selectedDriveFolder
                ? await sendMessage(
                    page.fb_page_id,
                    page.access_token,
                    contact.psid,
                    message,
                    messagingType || 'RESPONSE',
                    undefined,
                    undefined,
                    undefined,
                    [{
                        type: 'URL',
                        text: selectedDriveFolder.button_text,
                        url: selectedDriveFolder.folder_url
                    }]
                )
                : await sendMessage(
                    page.fb_page_id,
                    page.access_token,
                    contact.psid,
                    message,
                    messagingType || 'RESPONSE'
                );
            await recordOutboundMessageEvent(supabase, {
                pageId: job.page_id,
                contactId: job.contact_id,
                messageId: sendResult.message_id,
                sourceType: 'chatbot',
                sourceId: job.id,
                sourceName: job.schedule_type === 'human_agent'
                    ? 'AI Chatbot day 2-7 follow-up'
                    : 'AI Chatbot quick follow-up',
                messageKind: messagingType || 'RESPONSE'
            });

            if (selectedDriveFiles.length > 0) {
                try {
                    const mediaResult = await sendMessengerGenericCarousel(
                        page.fb_page_id,
                        page.access_token,
                        contact.psid,
                        selectedDriveFiles.map((file) => ({
                            title: file.name,
                            subtitle: file.media_type === 'image' ? 'Image sample' : 'Video sample',
                            url: file.web_view_url,
                            imageUrl: file.thumbnail_url || undefined,
                            buttonTitle: file.media_type === 'image' ? 'View image' : 'Watch video'
                        })),
                        messagingType || 'RESPONSE'
                    );
                    await recordOutboundMessageEvent(supabase, {
                        pageId: job.page_id,
                        contactId: job.contact_id,
                        messageId: mediaResult.message_id,
                        sourceType: 'chatbot',
                        sourceId: job.id,
                        sourceName: selectedDriveFiles.length > 1
                            ? `AI Chatbot follow-up Drive carousel (${selectedDriveFiles.length} cards)`
                            : `AI Chatbot follow-up Drive card: ${selectedDriveFiles[0].name}`,
                        messageKind: `${messagingType || 'RESPONSE'} Drive media ${selectedDriveFiles.length > 1 ? 'carousel' : 'card'}`
                    });
                    result.mediaSent += 1;
                } catch (driveCarouselError) {
                    console.warn('[CHATBOT_FOLLOW_UP] Text sent but Drive carousel failed', {
                        jobId: job.id,
                        error: (driveCarouselError as Error).message
                    });
                }
            }

            if (selectedMediaItems.length > 0) {
                try {
                    if (selectedMediaItems.length > 0) {
                        const cards = await Promise.all(selectedMediaItems.map(async (media) => {
                            const mediaUrl = await createChatbotMediaSignedUrl(media);
                            return {
                                title: media.title,
                                subtitle: media.usage_notes || `${media.media_type === 'image' ? 'Image' : 'Video'} sample`,
                                url: createChatbotMediaPublicViewUrl(media.id),
                                imageUrl: media.media_type === 'image' ? mediaUrl : undefined,
                                buttonTitle: media.media_type === 'image' ? 'View image' : 'Watch video'
                            };
                        }));
                        const mediaResult = await sendMessengerGenericCarousel(
                            page.fb_page_id,
                            page.access_token,
                            contact.psid,
                            cards,
                            messagingType || 'RESPONSE'
                        );
                        await recordOutboundMessageEvent(supabase, {
                            pageId: job.page_id,
                            contactId: job.contact_id,
                            messageId: mediaResult.message_id,
                            sourceType: 'chatbot',
                            sourceId: job.id,
                            sourceName: selectedMediaItems.length > 1
                                ? `AI Chatbot follow-up media carousel (${selectedMediaItems.length} cards)`
                                : `AI Chatbot follow-up media card: ${selectedMediaItems[0].title}`,
                            messageKind: selectedMediaItems.length > 1
                                ? `${messagingType || 'RESPONSE'} media carousel`
                                : `${messagingType || 'RESPONSE'} media card`
                        });
                        result.mediaSent += 1;
                    }
                } catch (mediaError) {
                    console.warn('[CHATBOT_FOLLOW_UP] Text sent but media failed', {
                        jobId: job.id,
                        error: (mediaError as Error).message
                    });
                }
            }

            await markJob(supabase, job.id, {
                status: 'sent',
                message_id: sendResult.message_id,
                message_text: personalizedMessage,
                media_asset_id: selectedMedia?.id || null,
                sent_at: now.toISOString(),
                claimed_at: null,
                error_message: null
            });
            result.sent += 1;
        } catch (sendError) {
            const attempts = Number(job.attempt_count || 0) + 1;
            await markJob(supabase, job.id, attempts >= MAX_ATTEMPTS ? {
                status: 'failed',
                attempt_count: attempts,
                claimed_at: null,
                error_message: (sendError as Error).message.slice(0, 1000)
            } : {
                status: 'pending',
                attempt_count: attempts,
                claimed_at: null,
                due_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
                error_message: (sendError as Error).message.slice(0, 1000)
            });
            result.failed += 1;
        }
    }

    return result;
}
