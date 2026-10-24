import { getConversationForPsid, sendMessage, sendMessengerGenericCarousel } from '@/lib/facebook';
import {
    createChatbotMediaPublicViewUrl,
    createChatbotMediaSignedUrl,
    getReadyChatbotMediaForDocuments,
    type ChatbotMediaAsset
} from '@/lib/chatbot-media';
import { recordOutboundMessageEvent } from '@/lib/outbound-message-events';
import { getBestTimeFollowUpDueAt, normalizeBestTimeFollowUpDays } from '@/lib/chatbot-follow-up-timing';
export { getBestTimeFollowUpDueAt, normalizeBestTimeFollowUpDays } from '@/lib/chatbot-follow-up-timing';
import { replaceTemplateVariables } from '@/lib/placeholders';
import { getSupabaseAdmin } from '@/lib/supabase';
import { generateChatbotFollowUp, getChatbotKnowledgePageId, type ChatbotConfig } from '@/lib/chatbot';
import { getChatbotHandoffOptions, isChatbotContactAllowed, saveChatbotContactState, type ChatbotContactState } from '@/lib/chatbot-control';
import { evaluateCommercialVideoIntake, isCommercialVideoIntake, resolveCommercialVideoRequest } from '@/lib/chatbot-policy';
import { normalizeCommercialVideoDetails } from '@/lib/chatbot-intake';
import { findLatestMessengerSystemSignal, getMessengerHandoffMetadata, loadMessengerHistoryForStopCheck } from '@/lib/messaging-auto-tag';
import { getReadyChatbotDriveFilesForDocuments, getReadyChatbotDriveFolderForDocument, type ChatbotDriveFile, type ChatbotDriveFolder } from '@/lib/chatbot-drive-folders';
import { isPipelineClosedForAutomation, pipelineStageForMessengerSignal, updateContactPipelineStage, type ContactPipelineStage, type ContactPipelineSource } from '@/lib/contact-pipeline';
import { assertChatbotDeliveryAllowed, ChatbotDeliveryStoppedError } from '@/lib/chatbot-delivery';
import { ChatbotFollowUpRepeatedError, hasRepeatedChatbotCopy } from '@/lib/chatbot-message-copy';
import { getCommercialVideoMessageControls } from '@/lib/chatbot-interactions';
import { buildFirstDaySchedule, firstDayDeadline, getFirstDayCandidate, nextFirstDayWakingTime } from '@/lib/chatbot-first-day-timing';
import { assertPricingOfferActive, beginPricingDelivery, getContactPricingCatalog, getPricingQuoteContext, PricingDeliveryUncertainError, recordPricingDelivery, releasePricingOffer, renderPricingOffer, reservePricingOffer, schedulePricingPromotion, type PricingOffer } from '@/lib/chatbot-pricing';

const RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const HUMAN_AGENT_WINDOW_MS = 7 * RESPONSE_WINDOW_MS;
const RESPONSE_SAFETY_MS = 60 * 1000;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

type SupabaseLike = { from: (table: string) => any; rpc?: (name: string, args: Record<string, unknown>) => any };

type ScheduleContact = {
    id: string;
    page_id: string;
    psid: string;
    name?: string | null;
    best_contact_hour?: number | null;
    last_interaction_at?: string | null;
    last_inbound_at?: string | null;
    first_interaction_at?: string | null;
    pipeline_stage?: ContactPipelineStage | null;
    pipeline_stage_source?: ContactPipelineSource | null;
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
    message_id?: string | null;
    attempt_count: number;
    media_asset_id?: string | null;
    purpose?: 'scheduled' | 'nightly_continuation' | 'first_day_adaptive' | 'pricing_promotion';
    automation_epoch?: number;
    policy_revision?: number;
    timing_context?: { initial_reply_end?: string; carried_sent_times?: string[] } | null;
};

export function normalizeQuickFollowUpDelays(value: unknown): number[] {
    return Array.from(new Set(
        (Array.isArray(value) ? value : [])
            .map((item) => Math.round(Number(item)))
            .filter((item) => Number.isFinite(item) && item >= 1 && item <= 1439)
    )).sort((a, b) => a - b).slice(0, 10);
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

export async function cancelPendingChatbotFollowUps(input: {
    supabase: SupabaseLike;
    pageId: string;
    contactId: string;
    reason?: string;
    now?: Date;
    exceptJobId?: string;
    beforeAnchorInboundAt?: string;
}) {
    const now = input.now || new Date();
    let query = input.supabase
        .from('chatbot_follow_up_jobs')
        .update({
            status: 'cancelled',
            cancelled_at: now.toISOString(),
            error_message: input.reason || 'Customer replied',
            claimed_at: null,
            updated_at: now.toISOString()
        })
        .eq('page_id', input.pageId)
        .eq('contact_id', input.contactId);
    if (input.exceptJobId) query = query.neq('id', input.exceptJobId);
    if (input.beforeAnchorInboundAt) query = query.lt('anchor_inbound_at', input.beforeAnchorInboundAt);
    const { error } = await query.in('status', ['pending', 'processing', 'ready_manual', 'waiting_response']);
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
    if (isPipelineClosedForAutomation(input.contact.pipeline_stage, input.contact.pipeline_stage_source, input.config)) return 0;

    let scopedState: ChatbotContactState | null = null;
    if (isCommercialVideoIntake(input.config)) {
        const { data, error } = await input.supabase.from('chatbot_contact_states').select('*')
            .eq('page_id', input.pageId).eq('contact_id', input.contact.id).maybeSingle();
        if (error) throw new Error(error.message);
        scopedState = data;
        if (scopedState?.status === 'stopped' || !evaluateCommercialVideoIntake(scopedState?.collected_details || {}, scopedState?.has_clear_request === true).needsContinuation) return 0;
    }

    const now = input.now || new Date();
    const anchor = new Date(input.anchorInboundAt);
    if (!Number.isFinite(anchor.getTime())) return 0;
    await cancelPendingChatbotFollowUps({
        supabase: input.supabase,
        pageId: input.pageId,
        contactId: input.contact.id,
        reason: 'Replaced by a newer follow-up sequence',
        beforeAnchorInboundAt: input.anchorInboundAt,
        now
    });

    const firstInquiry = Date.parse(input.contact.first_interaction_at || '');
    const useAdaptive = input.config.follow_up_first_day_mode === 'adaptive' && firstInquiry === anchor.getTime();
    const unknownFirstInquiry = input.config.follow_up_first_day_mode === 'adaptive' && !Number.isFinite(firstInquiry);
    const returnedDuringFirstDay = input.config.follow_up_first_day_mode === 'adaptive' &&
        Number.isFinite(firstInquiry) && firstInquiry < anchor.getTime() && anchor.getTime() < firstInquiry + RESPONSE_WINDOW_MS;
    const quickTimes = useAdaptive
        ? buildFirstDaySchedule({ firstInquiry, initialReplyEnd: now.getTime(), lastOutbound: now.getTime(), now: now.getTime() })
        : returnedDuringFirstDay || unknownFirstInquiry ? [] : normalizeQuickFollowUpDelays(input.config.follow_up_quick_delays_minutes)
            .map((delay, sequenceIndex) => ({ sequenceIndex, dueAt: new Date(anchor.getTime() + delay * 60 * 1000).toISOString() }));
    const quickJobs = quickTimes
        .map((delay) => ({
            page_id: input.pageId,
            contact_id: input.contact.id,
            anchor_inbound_at: input.anchorInboundAt,
            schedule_type: 'response',
            sequence_index: delay.sequenceIndex,
            due_at: delay.dueAt,
            purpose: useAdaptive ? 'first_day_adaptive' : 'scheduled',
            timing_context: useAdaptive ? { initial_reply_end: now.toISOString() } : null,
            message_text: 'AI-generated from conversation at send time',
            status: 'pending'
        }));
    const pricingSchedule = await schedulePricingPromotion(input.supabase, {
        pageId: input.pageId, contactId: input.contact.id, anchorInboundAt: input.anchorInboundAt,
        days: normalizeBestTimeFollowUpDays(input.config.follow_up_best_time_days), bestHour: input.contact.best_contact_hour,
        automationEpoch: scopedState?.automation_epoch, policyRevision: input.config.policy_revision
    });
    const bestTimeJobs = (pricingSchedule.managed ? [] : normalizeBestTimeFollowUpDays(input.config.follow_up_best_time_days))
        .map((day, index) => ({
            page_id: input.pageId,
            contact_id: input.contact.id,
            anchor_inbound_at: input.anchorInboundAt,
            schedule_type: 'human_agent',
            purpose: 'scheduled',
            timing_context: null,
            sequence_index: index,
            due_at: getBestTimeFollowUpDueAt(anchor, day, input.contact.best_contact_hour),
            message_text: 'AI-generated from conversation at send time',
            status: 'pending'
        }));
    const jobs = [...quickJobs, ...bestTimeJobs].filter((job) => new Date(job.due_at).getTime() > now.getTime())
        .map(job => ({ ...job, automation_epoch: scopedState?.automation_epoch || 0,
            policy_revision: input.config.policy_revision || 1 }));
    if (jobs.length === 0) return pricingSchedule.scheduled;
    const { error } = await input.supabase.from('chatbot_follow_up_jobs').upsert(jobs, {
        onConflict: 'contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose',
        // A replay must never revive a sent/cancelled job or reset its claim.
        ignoreDuplicates: true
    });
    if (error) throw new Error(error.message || 'Could not schedule chatbot follow-ups');
    return jobs.length + pricingSchedule.scheduled;
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
        .select('*')
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

        let deliveredMessageId: string | undefined;
        let pricingOffer: PricingOffer | null = null;
        let pricingSendStarted = false;
        try {
            if (job.message_id) {
                await markJob(supabase, job.id, { status: 'failed', claimed_at: null,
                    error_message: 'Earlier delivery was recorded; do not replay this follow-up' });
                result.cancelled++;
                continue;
            }
            const loadDeliveredCopy = async (): Promise<string[]> => {
                const previous = await supabase.from('chatbot_follow_up_jobs').select('id,message_text,message_id')
                    .eq('page_id', job.page_id).eq('contact_id', job.contact_id)
                    .not('message_id', 'is', null)
                    .order('updated_at', { ascending: false }).limit(30);
                if (previous.error) throw new Error(previous.error.message || 'Could not check earlier follow-up delivery');
                return (previous.data || []).filter((row: any) => row.id !== job.id && row.message_id && typeof row.message_text === 'string')
                    .map((row: any) => row.message_text).filter((text: string) => text.trim() && text !== 'AI-generated from conversation at send time');
            };
            const eligibility = await Promise.all([
                supabase.from('pages').select('id, name, fb_page_id, access_token').eq('id', job.page_id).maybeSingle(),
                supabase.from('contacts').select('id, page_id, psid, name, best_contact_hour, first_interaction_at, last_interaction_at, last_inbound_at, pipeline_stage,pipeline_stage_source').eq('id', job.contact_id).maybeSingle(),
                supabase.from('chatbot_configs').select('*').eq('page_id', job.page_id).maybeSingle(),
                supabase.from('chatbot_contact_states').select('*').eq('page_id', job.page_id).eq('contact_id', job.contact_id).maybeSingle()
            ]);
            for (const lookup of eligibility) {
                if (lookup.error) throw new Error(lookup.error.message || 'Could not verify follow-up eligibility');
            }
            const [{ data: page }, { data: contact }, { data: config }, { data: state }] = eligibility;
            const anchorTime = new Date(job.anchor_inbound_at).getTime();
            const latestInboundTime = new Date(contact?.last_inbound_at || contact?.last_interaction_at || 0).getTime();
            const messagingType = getAutomatedFollowUpMessagingType(
                job.schedule_type,
                job.anchor_inbound_at,
                now
            );
            if (!page?.access_token || !contact?.psid || !config?.enabled || !config?.follow_up_enabled ||
                !isChatbotContactAllowed(config, job.contact_id) ||
                state?.status === 'stopped' || isPipelineClosedForAutomation(contact?.pipeline_stage, contact?.pipeline_stage_source, config) ||
                (isCommercialVideoIntake(config) && ((job.automation_epoch || 0) !== (state?.automation_epoch || 0) ||
                    (job.policy_revision || 1) !== (config.policy_revision || 1))) ||
                latestInboundTime > anchorTime ||
                (job.purpose === 'first_day_adaptive' && config?.follow_up_first_day_mode !== 'adaptive') ||
                (job.schedule_type === 'response' && job.purpose === 'scheduled' &&
                    config?.follow_up_first_day_mode === 'adaptive' &&
                    Date.parse(contact?.first_interaction_at || '') === anchorTime) ||
                (!messagingType && job.schedule_type !== 'manual_human_agent' && job.purpose !== 'pricing_promotion')) {
                if (state?.status === 'stopped' || isPipelineClosedForAutomation(contact?.pipeline_stage, contact?.pipeline_stage_source, config)) {
                    await cancelPendingChatbotFollowUps({ supabase, pageId: job.page_id, contactId: job.contact_id,
                        reason: 'Contact stopped or handed off', now });
                }
                await markJob(supabase, job.id, {
                    status: 'cancelled',
                    cancelled_at: now.toISOString(),
                    claimed_at: null,
                    error_message: 'Follow-up no longer eligible'
                });
                result.cancelled += 1;
                continue;
            }
            if (job.purpose === 'pricing_promotion' && (!messagingType || job.schedule_type !== 'response')) {
                await markJob(supabase, job.id, { status: 'waiting_response', claimed_at: null,
                    error_message: 'Later-day promotion is waiting for an eligible Messenger response window' });
                continue;
            }

            let personalizedMessage = '';
            let personalizedMessages: string[] = [];
            let selectedMediaItems: ChatbotMediaAsset[] = [];
            let selectedDriveFiles: ChatbotDriveFile[] = [];
            let selectedDriveFolder: ChatbotDriveFolder | null = null;
            const conversation = await getConversationForPsid(
                page.fb_page_id,
                contact.psid,
                page.access_token,
                { throwOnError: true, timeoutMs: 5000 }
            );
            const stageHistory = await loadMessengerHistoryForStopCheck({
                facebookPageId: page.fb_page_id, accessToken: page.access_token, initialPage: conversation?.messages, requireAvailable: true,
                ...getChatbotHandoffOptions(state, job.anchor_inbound_at)
            });
            const handoffOptions = getChatbotHandoffOptions(state, job.anchor_inbound_at);
            const liveStopReason = findLatestMessengerSystemSignal(stageHistory, page.fb_page_id, handoffOptions);
            if (liveStopReason) {
                await saveChatbotContactState(supabase, {
                    pageId: job.page_id,
                    contactId: job.contact_id,
                    existingState: state as ChatbotContactState | null,
                    stopReason: liveStopReason,
                    ...getMessengerHandoffMetadata(stageHistory, page.fb_page_id, handoffOptions),
                    now
                });
                await cancelPendingChatbotFollowUps({
                    supabase, pageId: job.page_id, contactId: job.contact_id,
                    reason: `Messenger lead stage: ${liveStopReason}`, now
                });
                await updateContactPipelineStage(supabase, {
                    pageId: job.page_id,
                    contactId: job.contact_id,
                    stage: pipelineStageForMessengerSignal(liveStopReason),
                    source: 'messenger',
                    now
                });
                await markJob(supabase, job.id, {
                    status: 'cancelled', cancelled_at: now.toISOString(), claimed_at: null,
                    error_message: `Messenger lead stage: ${liveStopReason}`
                });
                result.cancelled += 1;
                continue;
            }
            // The stop audit has already fetched older message pages. Reuse
            // them for personalization instead of dropping customer context
            // when the first page contains only newer Page messages.
            const conversationHistory = stageHistory.flatMap(message => {
                if (typeof message.message !== 'string' || !message.from?.id) return [];
                return [{ ...message, id: message.id || '', message: message.message,
                    from: { ...message.from, id: message.from.id, name: message.from.name || '' }, created_time: message.created_time || '' }];
            });
            const hasCustomerMessage = hasReadableCustomerConversationHistory(
                conversationHistory,
                page.fb_page_id
            );
            if (!hasCustomerMessage) {
                throw new Error('Messenger conversation history is unavailable; personalized follow-up was not sent');
            }
            if (conversationHistory.some(message => message.from.id !== page.fb_page_id &&
                Date.parse(message.created_time) > anchorTime)) {
                await markJob(supabase, job.id, { status: 'cancelled', cancelled_at: now.toISOString(), claimed_at: null,
                    error_message: 'A newer customer message is awaiting webhook reconciliation' });
                result.cancelled++;
                continue;
            }
            const recheckAdaptiveTiming = async () => {
                if (job.purpose !== 'first_day_adaptive') return true;
                const clock = input.now || new Date();
                if (clock.getTime() >= firstDayDeadline(anchorTime)) {
                    await markJob(supabase, job.id, { status: 'cancelled', claimed_at: null,
                        cancelled_at: clock.toISOString(), error_message: 'Original first-day deadline ended' });
                    result.cancelled++;
                    return false;
                }
                let previousSentAt: number | undefined;
                if (job.sequence_index > 0) {
                    const previous = await supabase.from('chatbot_follow_up_jobs')
                        .select('status,sent_at,due_at,message_id')
                        .eq('page_id', job.page_id).eq('contact_id', job.contact_id)
                        .eq('anchor_inbound_at', job.anchor_inbound_at).eq('purpose', 'first_day_adaptive')
                        .eq('automation_epoch', job.automation_epoch || 0)
                        .eq('sequence_index', job.sequence_index - 1).maybeSingle();
                    if (previous.error) throw new Error(previous.error.message || 'Could not check preceding first-day follow-up');
                    if (previous.data?.status === 'pending' || previous.data?.status === 'processing') {
                        await markJob(supabase, job.id, { status: 'pending', claimed_at: null,
                            due_at: new Date(clock.getTime() + 60_000).toISOString(),
                            error_message: 'Waiting for the preceding first-day reminder' });
                        return false;
                    }
                    const carried = job.timing_context?.carried_sent_times || [];
                    if (!previous.data && carried.length === job.sequence_index && carried.length > 0) {
                        previousSentAt = Date.parse(carried[carried.length - 1]);
                    } else if (previous.data?.status !== 'sent' || !previous.data.message_id ||
                        !Number.isFinite(Date.parse(previous.data.sent_at))) {
                        await markJob(supabase, job.id, { status: 'cancelled', claimed_at: null,
                            cancelled_at: clock.toISOString(), error_message: 'Preceding first-day reminder was not delivered' });
                        result.cancelled++;
                        return false;
                    } else {
                        previousSentAt = Date.parse(previous.data.sent_at);
                    }
                }
                const initialReplyEnd = Math.max(anchorTime, Date.parse(job.timing_context?.initial_reply_end || state?.last_bot_reply_at || '') || anchorTime);
                const lastOutbound = Math.max(initialReplyEnd, ...conversationHistory
                    .filter(message => message.from.id === page.fb_page_id)
                    .map(message => Date.parse(message.created_time)).filter(Number.isFinite));
                const candidate = getFirstDayCandidate({ firstInquiry: anchorTime, initialReplyEnd,
                    lastOutbound, now: clock.getTime(), sequenceIndex: job.sequence_index, previousSentAt });
                if (candidate === null) {
                    await markJob(supabase, job.id, { status: 'cancelled', claimed_at: null,
                        cancelled_at: clock.toISOString(), error_message: 'No remaining first-day timing opportunity' });
                    result.cancelled++;
                    return false;
                }
                if (candidate > clock.getTime()) {
                    await markJob(supabase, job.id, { status: 'pending', claimed_at: null,
                        due_at: new Date(candidate).toISOString(), error_message: 'Adjusted to actual delivery gap and waking hours' });
                    return false;
                }
                return true;
            };
            if (!await recheckAdaptiveTiming()) continue;
            const request = resolveCommercialVideoRequest({ history: conversationHistory, pageId: page.fb_page_id,
                hasClearRequest: state?.has_clear_request, requestType: state?.request_type, requestEvidence: state?.request_evidence });
            if (isCommercialVideoIntake(config) && !evaluateCommercialVideoIntake(state?.collected_details || {}, request.has_clear_request).needsContinuation) {
                await saveChatbotContactState(supabase, { pageId: job.page_id, contactId: job.contact_id, existingState: state,
                    stopReason: 'details_collected', pauseKind: 'ready_for_team', hasClearRequest: request.has_clear_request,
                    requestType: request.request_type, requestEvidence: request.request_evidence });
                await cancelPendingChatbotFollowUps({ supabase, pageId: job.page_id, contactId: job.contact_id, reason: 'Form and customer request complete', now });
                result.cancelled++;
                continue;
            }
            if (isCommercialVideoIntake(config) && request.has_clear_request &&
                (state?.has_clear_request !== true || state?.request_type !== request.request_type)) {
                await saveChatbotContactState(supabase, { pageId: job.page_id, contactId: job.contact_id, existingState: state,
                    hasClearRequest: true, requestType: request.request_type, requestEvidence: request.request_evidence });
            }
            const quote = getPricingQuoteContext({ config, pageId: page.fb_page_id, history: conversationHistory,
                collectedDetails: state?.collected_details || {}, hasClearRequest: request.has_clear_request });
            // Promotional catalogs use RESPONSE only, including when the ordinary scheduler permits HUMAN_AGENT.
            if (job.purpose === 'pricing_promotion' && job.schedule_type === 'response' && messagingType === 'RESPONSE') {
                pricingOffer = await reservePricingOffer(supabase, { pageId: job.page_id, contactId: job.contact_id,
                    sourceKey: 'follow-up:' + job.id, followUp: true, quoteEligible: quote.eligible, durationSeconds: quote.durationSeconds,
                    enforceDiscovery: isCommercialVideoIntake(config) });
            }
            if (job.purpose === 'pricing_promotion' && !pricingOffer) {
                const next = await schedulePricingPromotion(supabase, { pageId: job.page_id, contactId: job.contact_id,
                    anchorInboundAt: job.anchor_inbound_at, days: normalizeBestTimeFollowUpDays(config.follow_up_best_time_days),
                    bestHour: contact.best_contact_hour, automationEpoch: state?.automation_epoch, policyRevision: config.policy_revision });
                await markJob(supabase, job.id, next.managed && next.due_at ? { status: next.waiting_response ? 'waiting_response' : 'pending',
                    due_at: next.due_at, claimed_at: null, error_message: 'Keeping the current package for its full day' }
                    : { status: 'cancelled', claimed_at: null, cancelled_at: now.toISOString(), error_message: 'No remaining eligible pricing day' });
                continue;
            }
            if (pricingOffer) {
                personalizedMessages = [renderPricingOffer(pricingOffer, { commercial: isCommercialVideoIntake(config), followUp: true,
                    contactName: contact.name, business: state?.collected_details?.['Business Name'] })];
                personalizedMessage = personalizedMessages.join('\n\n');
            } else {
            try {
                const knowledgePageId = getChatbotKnowledgePageId(config as ChatbotConfig);
                const generated = await generateChatbotFollowUp({
                    pricingCatalog: await getContactPricingCatalog(supabase, job.page_id, job.contact_id),
                    config: job.purpose === 'nightly_continuation' || job.sequence_index >= 1000 ? { ...config,
                        follow_up_ai_instructions: `${config.follow_up_ai_instructions}\nThis is a reviewed intake continuation. Continue from the customer's unresolved question or objection and ask at most one previously unanswered detail. Keep all earlier answers; never restart intake or ask for an equivalent known detail.`
                    } as ChatbotConfig : config as ChatbotConfig,
                    contactName: contact.name,
                    pageName: page.name,
                    pageId: page.fb_page_id,
                    history: conversationHistory,
                    collectedDetails: isCommercialVideoIntake(config) ? normalizeCommercialVideoDetails(state?.collected_details || {}) : state?.collected_details || {},
                    missingDetails: state?.missing_details || [],
                    hasClearRequest: request.has_clear_request,
                    requestType: request.request_type,
                    requestEvidence: request.request_evidence,
                    previousFollowUpMessages: await loadDeliveredCopy(),
                    sequenceNumber: job.purpose === 'nightly_continuation' || job.sequence_index >= 1000 ? 1 : job.sequence_index + 1,
                    scheduleLabel: job.schedule_type === 'response' ? 'first 24 hours' : 'best-time day 2-7'
                });
                if (generated.generation_warning) {
                    throw new Error('AI could not create a validated personalized follow-up');
                }
                personalizedMessage = generated.message;
                personalizedMessages = generated.messages?.length
                    ? generated.messages
                    : [generated.message];
                const generatedMediaDocumentIds = generated.media_document_ids?.length
                    ? generated.media_document_ids
                    : generated.media_document_id
                        ? [generated.media_document_id]
                        : [];
                if (generatedMediaDocumentIds.length > 0) {
                    selectedMediaItems = await getReadyChatbotMediaForDocuments({
                        pageId: knowledgePageId,
                        documentIds: generatedMediaDocumentIds
                    });
                }
                if (generated.drive_file_document_ids?.length) {
                    selectedDriveFiles = await getReadyChatbotDriveFilesForDocuments({
                        pageId: knowledgePageId,
                        documentIds: generated.drive_file_document_ids
                    });
                }
                if (generated.link_document_id && selectedDriveFiles.length === 0 && job.schedule_type === 'response') {
                    selectedDriveFolder = await getReadyChatbotDriveFolderForDocument({
                        pageId: knowledgePageId,
                        documentId: generated.link_document_id
                    });
                }
            } catch (generationError) {
                if (generationError instanceof ChatbotFollowUpRepeatedError) throw generationError;
                console.warn('[CHATBOT_FOLLOW_UP] AI personalization failed; follow-up will not use a generic fallback', {
                    jobId: job.id,
                    error: (generationError as Error).message
                });
                throw new Error(`AI personalization failed: ${(generationError as Error).message}`);
            }
            }

            const selectedMedia = selectedMediaItems[0] || null;

            // AI generation can take seconds. A stage change or new inbound
            // during that time must invalidate this job before any delivery.
            const freshEligibility = await Promise.all([
                supabase.from('contacts').select('pipeline_stage,pipeline_stage_source,last_inbound_at').eq('page_id', job.page_id).eq('id', job.contact_id).maybeSingle(),
                supabase.from('chatbot_contact_states').select('*').eq('page_id', job.page_id).eq('contact_id', job.contact_id).maybeSingle(),
                supabase.from('chatbot_configs').select('enabled,follow_up_enabled,follow_up_first_day_mode,trial_mode_enabled,trial_contact_id,commercial_video_intake_enabled,policy_revision').eq('page_id', job.page_id).maybeSingle()
            ]);
            for (const lookup of freshEligibility) {
                if (lookup.error) throw new Error(lookup.error.message || 'Could not recheck follow-up eligibility');
            }
            const [freshContact, freshState, freshConfig] = freshEligibility.map(lookup => lookup.data);
            if (!freshContact || !freshConfig?.enabled || !freshConfig.follow_up_enabled ||
                !isChatbotContactAllowed(freshConfig, job.contact_id) || freshState?.status === 'stopped' ||
                isPipelineClosedForAutomation(freshContact.pipeline_stage, freshContact.pipeline_stage_source, freshConfig) ||
                (isCommercialVideoIntake(freshConfig) && ((job.automation_epoch || 0) !== (freshState?.automation_epoch || 0) ||
                    (job.policy_revision || 1) !== (freshConfig.policy_revision || 1))) ||
                new Date(freshContact.last_inbound_at || 0).getTime() > anchorTime) {
                if (freshState?.status === 'stopped' || isPipelineClosedForAutomation(freshContact?.pipeline_stage, freshContact?.pipeline_stage_source, freshConfig)) {
                    await cancelPendingChatbotFollowUps({ supabase, pageId: job.page_id, contactId: job.contact_id,
                        reason: 'Contact stopped or handed off during generation', now });
                }
                await markJob(supabase, job.id, {
                    status: 'cancelled', cancelled_at: now.toISOString(), claimed_at: null,
                    error_message: 'Follow-up eligibility changed during generation'
                });
                result.cancelled += 1;
                continue;
            }
            if (job.purpose === 'first_day_adaptive' && freshConfig.follow_up_first_day_mode !== 'adaptive') {
                await markJob(supabase, job.id, { status: 'cancelled', claimed_at: null,
                    cancelled_at: (input.now || new Date()).toISOString(), error_message: 'First-day timing mode changed during generation' });
                result.cancelled++;
                continue;
            }
            if (!await recheckAdaptiveTiming()) continue;

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
            const messageParts = personalizedMessages
                .map(part => replaceTemplateVariables(part, placeholderContact).trim())
                .filter(Boolean);
            if (messageParts.length === 0) throw new Error('AI follow-up did not contain a sendable message');
            // The pricing reservation checks package identity and prior delivery atomically.
            // Shared terms or a CTA across different approved packages are intentional.
            if (!pricingOffer && hasRepeatedChatbotCopy(messageParts, await loadDeliveredCopy(), { allowRepeatedFormsAndSamples: isCommercialVideoIntake(config) })) {
                throw new ChatbotFollowUpRepeatedError('Another follow-up already delivered this copy; duplicate cancelled');
            }
            const followUpSourceName = job.schedule_type === 'human_agent'
                ? 'AI Chatbot day 2-7 follow-up'
                : 'AI Chatbot quick follow-up';
            let lastSendResult: { message_id: string } | null = null;
            const checkDelivery = () => {
                const clock = (input.now || new Date()).getTime();
                if (job.purpose === 'first_day_adaptive' &&
                    (clock >= firstDayDeadline(anchorTime) || nextFirstDayWakingTime(clock) !== clock)) {
                    throw new ChatbotDeliveryStoppedError('First-day timing window ended before delivery');
                }
                return assertChatbotDeliveryAllowed({
                supabase, pageId: job.page_id, facebookPageId: page.fb_page_id, accessToken: page.access_token,
                contactId: job.contact_id, psid: contact.psid, followUp: true, followUpJobId: job.id, anchorInboundAt: job.anchor_inbound_at,
                automationEpoch: isCommercialVideoIntake(config) ? job.automation_epoch || 0 : undefined,
                policyRevision: isCommercialVideoIntake(config) ? job.policy_revision || 1 : undefined
                });
            };
            const deferQuestion = isCommercialVideoIntake(config) &&
                (selectedDriveFiles.length > 0 || selectedMediaItems.length > 0) &&
                messageParts.length > 1 && /\?\s*$/.test(messageParts[messageParts.length - 1]);
            const sendTextPart = async (partIndex: number) => {
                const message = messageParts[partIndex];
                const controls = isCommercialVideoIntake(config)
                    ? getCommercialVideoMessageControls(messageParts).find(item => item.message_index === partIndex) : undefined;
                await checkDelivery();
                if (pricingOffer) {
                    if (getAutomatedFollowUpMessagingType('response', job.anchor_inbound_at, input.now || new Date()) !== 'RESPONSE') {
                        throw new ChatbotDeliveryStoppedError('Promotional pricing response window ended');
                    }
                    await assertPricingOfferActive(supabase, pricingOffer);
                }
                const isFinalPart = partIndex === messageParts.length - 1;
                const sendArgs: Parameters<typeof sendMessage> = [page.fb_page_id, page.access_token, contact.psid, message, messagingType || 'RESPONSE'];
                const buttons = [
                        ...(controls?.buttons || []).map(button => ({ type: 'POSTBACK' as const, text: button.title, payload: button.payload })),
                        ...(selectedDriveFolder && isFinalPart ? [{
                            type: 'URL',
                            text: selectedDriveFolder.button_text,
                            url: selectedDriveFolder.folder_url
                        } as const] : [])
                ];
                if (buttons.length) sendArgs[8] = buttons;
                if (controls?.quick_replies?.length) sendArgs[10] = controls.quick_replies;
                if (pricingOffer) {
                    await beginPricingDelivery(supabase, pricingOffer);
                    pricingSendStarted = true;
                }
                const sendResult = await sendMessage(...sendArgs);
                lastSendResult = sendResult;
                deliveredMessageId = sendResult.message_id;
                if (pricingOffer) {
                    await recordPricingDelivery(supabase, pricingOffer, sendResult.message_id);
                }
                // Checkpoint each bubble before sending the next. A stale lease
                // must never replay a job that already delivered part of its copy.
                await markJob(supabase, job.id, { message_id: deliveredMessageId,
                    message_text: messageParts.slice(0, partIndex + 1).join('\n\n') });
                await recordOutboundMessageEvent(supabase, {
                    pageId: job.page_id,
                    contactId: job.contact_id,
                    messageId: sendResult.message_id,
                    sourceType: 'chatbot',
                    sourceId: job.id,
                    sourceName: messageParts.length > 1
                        ? `${followUpSourceName} (${partIndex + 1}/${messageParts.length})`
                        : followUpSourceName,
                    messageKind: messagingType || 'RESPONSE'
                });
            };
            for (let partIndex = 0; partIndex < messageParts.length - (deferQuestion ? 1 : 0); partIndex++) {
                await sendTextPart(partIndex);
            }

            if (selectedDriveFiles.length > 0) {
                try {
                    await checkDelivery();
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
                    if (driveCarouselError instanceof ChatbotDeliveryStoppedError) throw driveCarouselError;
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
                        await checkDelivery();
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
                    if (mediaError instanceof ChatbotDeliveryStoppedError) throw mediaError;
                    console.warn('[CHATBOT_FOLLOW_UP] Text sent but media failed', {
                        jobId: job.id,
                        error: (mediaError as Error).message
                    });
                }
            }

            if (deferQuestion) await sendTextPart(messageParts.length - 1);
            if (!lastSendResult) throw new Error('AI follow-up was not sent');

            await markJob(supabase, job.id, {
                status: 'sent',
                message_id: (lastSendResult as { message_id: string }).message_id,
                message_text: messageParts.join('\n\n'),
                media_asset_id: selectedMedia?.id || null,
                sent_at: (input.now || new Date()).toISOString(),
                claimed_at: null,
                error_message: null
            });
            result.sent += 1;
            if (pricingOffer) {
                await schedulePricingPromotion(supabase, { pageId: job.page_id, contactId: job.contact_id,
                    anchorInboundAt: job.anchor_inbound_at, days: normalizeBestTimeFollowUpDays(config.follow_up_best_time_days),
                    bestHour: contact.best_contact_hour, automationEpoch: state?.automation_epoch, policyRevision: config.policy_revision });
            }
        } catch (sendError) {
            if (sendError instanceof ChatbotDeliveryStoppedError || sendError instanceof ChatbotFollowUpRepeatedError) {
                await markJob(supabase, job.id, {
                    status: 'cancelled', cancelled_at: new Date().toISOString(), claimed_at: null,
                    error_message: sendError.message.slice(0, 1000)
                });
                result.cancelled += 1;
                continue;
            }
            const attempts = Number(job.attempt_count || 0) + 1;
            await markJob(supabase, job.id, deliveredMessageId || pricingSendStarted || sendError instanceof PricingDeliveryUncertainError || attempts >= MAX_ATTEMPTS ? {
                status: 'failed',
                ...(deliveredMessageId ? { message_id: deliveredMessageId } : {}),
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
        } finally {
            if (!pricingSendStarted) await releasePricingOffer(supabase, pricingOffer);
        }
    }

    return result;
}
