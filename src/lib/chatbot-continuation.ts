import { analyzeChatbotContinuation, extractChatbotContactDetails, type ChatbotConfig } from '@/lib/chatbot';
import { classifyChatbotStopIntent, getChatbotHandoffOptions, getMissingChatbotDetails, isChatbotContactAllowed, normalizeDetailsToCollect, saveChatbotContactState, type ChatbotContactState } from '@/lib/chatbot-control';
import { getConversationForPsid } from '@/lib/facebook';
import { classifyMessengerHistoryMessage, findLatestMessengerSystemSignal, loadMessengerHistoryForStopCheck } from '@/lib/messaging-auto-tag';
import { pipelineStageForMessengerSignal, updateContactPipelineStage } from '@/lib/contact-pipeline';
import { getSupabaseAdmin } from '@/lib/supabase';
import type { FacebookMessage } from '@/types';
import { evaluateCommercialVideoIntake, isCommercialVideoIntake } from '@/lib/chatbot-policy';

type Db = { from: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => any };
type Review = { id: string; state_id: string; page_id: string; contact_id: string; collection_round: number; attempt_count: number;
    review_kind?: 'legacy_intake' | 'nightly_handoff'; automation_epoch?: number; policy_revision?: number };

export function getContinuationDetailTarget(details: string[], collected: Record<string, string>): number | null {
    const requested = normalizeDetailsToCollect(details);
    const missing = getMissingChatbotDetails(requested, collected);
    return missing.length ? Math.min(requested.length, requested.length - missing.length + 3) : null;
}

/** Reviews never send directly; resumed follow-ups use the ordinary delivery guards. */
export async function processChatbotContinuationReviews(input: { supabase?: Db; now?: Date; limit?: number; timeBudgetMs?: number } = {}) {
    const db = input.supabase || getSupabaseAdmin();
    const now = input.now || new Date();
    const startedAt = Date.now();
    const timeBudgetMs = Math.max(1, input.timeBudgetMs ?? 45_000);
    const result = { checked: 0, resumed: 0, keptStopped: 0, skipped: 0, failed: 0 };
    const { data, error } = await db.rpc('claim_chatbot_continuation_reviews', {
        p_limit: input.limit || 2, p_now: now.toISOString()
    });
    if (error) throw new Error(error.message || 'Could not claim intake reviews');
    const mark = async (review: Review, payload: Record<string, unknown>) => {
        const { error } = await db.from('chatbot_continuation_reviews').update({
            claimed_at: null, reviewed_at: now.toISOString(), ...payload
        }).eq('id', review.id).eq('status', 'processing').eq('attempt_count', review.attempt_count);
        if (error) throw new Error(error.message);
    };
    for (const review of (data || []) as Review[]) {
        if (Date.now() - startedAt >= timeBudgetMs) {
            await mark(review, { status: 'pending', attempt_count: Math.max(0, review.attempt_count - 1), reviewed_at: null,
                error_message: 'Review deferred to next worker time budget' });
            continue;
        }
        result.checked++;
        try {
            const [pageResult, contactResult, stateResult, configResult] = await Promise.all([
                db.from('pages').select('id,name,fb_page_id,access_token').eq('id', review.page_id).maybeSingle(),
                db.from('contacts').select('id,name,psid,pipeline_stage,pipeline_stage_source,pipeline_stage_updated_at,last_inbound_at').eq('id', review.contact_id).eq('page_id', review.page_id).maybeSingle(),
                db.from('chatbot_contact_states').select('*').eq('id', review.state_id).eq('page_id', review.page_id).eq('contact_id', review.contact_id).maybeSingle(),
                db.from('chatbot_configs').select('*').eq('page_id', review.page_id).maybeSingle()
            ]);
            for (const lookup of [pageResult, contactResult, stateResult, configResult]) if (lookup.error) throw new Error(lookup.error.message);
            const page = pageResult.data, contact = contactResult.data;
            const state = stateResult.data as ChatbotContactState & { updated_at: string };
            const config = configResult.data as ChatbotConfig & { updated_at: string };
            if (review.review_kind === 'nightly_handoff') {
                if (!page?.access_token || !contact?.psid || !config?.enabled || !config.follow_up_enabled || !config.continuation_review_enabled ||
                    !isCommercialVideoIntake(config) || !isChatbotContactAllowed(config, review.contact_id) ||
                    state?.status !== 'stopped' || state.pause_kind !== 'human_takeover' || state.stop_reason !== 'manual' ||
                    state.automation_epoch !== review.automation_epoch || config.policy_revision !== review.policy_revision ||
                    ['converted', 'not_qualified', 'order_created', 'opted_out'].includes(contact.pipeline_stage) ||
                    (contact.pipeline_stage === 'qualified' && ['manual', 'messenger'].includes(contact.pipeline_stage_source))) {
                    await mark(review, { status: 'skipped', error_message: 'Nightly handoff is no longer eligible' }); result.skipped++; continue;
                }
                const conversation = await getConversationForPsid(page.fb_page_id, contact.psid, page.access_token, { throwOnError: true, timeoutMs: 5000 });
                // Unlike ordinary delivery stop checks, a nightly audit must read past
                // the acknowledged takeover to verify the absence of an earlier request.
                const history = await loadMessengerHistoryForStopCheck({ facebookPageId: page.fb_page_id, accessToken: page.access_token,
                    initialPage: conversation?.messages, requireAvailable: true, requireComplete: true,
                    ...getChatbotHandoffOptions(state) });
                const events = history.flatMap(message => {
                    const signal = classifyMessengerHistoryMessage(message, page.fb_page_id,
                        { ...getChatbotHandoffOptions(state) });
                    return signal ? [{ signal, message, time: Date.parse(message.created_time || '') }] : [];
                });
                const durable = events.filter(event => event.signal !== 'manual' ||
                    /^Lead stage set to /i.test(event.message?.message?.trim() || '')).sort((a, b) => b.time - a.time)[0];
                if (durable) {
                    await saveChatbotContactState(db, { pageId: review.page_id, contactId: review.contact_id, existingState: state,
                        stopReason: durable.signal, pauseKind: 'explicit_hold', now });
                    await updateContactPipelineStage(db, { pageId: review.page_id, contactId: review.contact_id,
                        stage: pipelineStageForMessengerSignal(durable.signal), source: 'messenger', now });
                    await mark(review, { status: 'kept_stopped', error_message: `Durable Messenger outcome: ${durable.signal}` }); result.keptStopped++; continue;
                }
                const latestHuman = events.filter(event => event.signal === 'manual' && Number.isFinite(event.time))
                    .sort((a, b) => b.time - a.time)[0];
                if (latestHuman && latestHuman.time > Date.parse(state.last_human_activity_at || state.stopped_at || '')) {
                    await saveChatbotContactState(db, { pageId: review.page_id, contactId: review.contact_id, existingState: state,
                        stopReason: 'manual', pauseKind: 'human_takeover', humanActivityAt: new Date(latestHuman.time).toISOString(), now });
                    await mark(review, { status: 'skipped', error_message: 'Newer staff activity requires a fresh handoff review' }); result.skipped++; continue;
                }
                const readable: FacebookMessage[] = history.flatMap(message => message.from?.id ? [{ id: message.id || '',
                    message: message.message || '', created_time: message.created_time || '',
                    from: { id: message.from.id, name: message.from.name || '' } }] : []);
                const customerMessages = readable.filter(message => message.from.id !== page.fb_page_id && message.message?.trim())
                    .sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time));
                const latestCustomer = customerMessages[0];
                if (!latestCustomer) throw new Error('Nightly review has no readable customer history');
                const stopReason = classifyChatbotStopIntent(latestCustomer.message || '', { stopOnOptOut: true, stopOnRefusal: true });
                if (stopReason) {
                    await saveChatbotContactState(db, { pageId: review.page_id, contactId: review.contact_id, existingState: state, stopReason, now });
                    await mark(review, { status: 'kept_stopped', error_message: `Customer stopped conversation: ${stopReason}` }); result.keptStopped++; continue;
                }
                if (Date.parse(latestCustomer.created_time) > Date.parse(contact.last_inbound_at || '')) {
                    throw new Error('Newer customer message is awaiting inbound-state reconciliation');
                }
                const extracted = await extractChatbotContactDetails({ config, contactName: contact.name, pageName: page.name,
                    pageId: page.fb_page_id, inboundMessage: latestCustomer.message || '', history: readable,
                    collectedDetails: state.collected_details, hasClearRequest: state.has_clear_request,
                    requestType: state.request_type, requestEvidence: state.request_evidence });
                // Full history was verified above. Unknown or undecided intent is not
                // agreement; an existing evidence-backed request is preserved by extraction.
                const hasClearRequest = state.has_clear_request === true || extracted.has_clear_request === true;
                const requestType = state.has_clear_request || extracted.request_type === undefined ? state.request_type || null : extracted.request_type;
                const requestEvidence = state.has_clear_request || extracted.request_evidence === undefined ? state.request_evidence || null : extracted.request_evidence;
                const decision = evaluateCommercialVideoIntake(extracted.collected_details, hasClearRequest);
                const analysis = { history_verified: true, form_complete: decision.formComplete,
                    has_clear_request: hasClearRequest, needs_continuation: !hasClearRequest,
                    missing_field_count: decision.missing_details.length, policy_revision: config.policy_revision,
                    automation_epoch: state.automation_epoch };
                if (hasClearRequest) {
                    await saveChatbotContactState(db, { pageId: review.page_id, contactId: review.contact_id, existingState: state,
                        collectedDetails: extracted.collected_details, missingDetails: decision.missing_details,
                        requestType, hasClearRequest, requestEvidence, now });
                    await mark(review, { status: 'kept_stopped', analysis }); result.keptStopped++; continue;
                }
                const { data: resumed, error: resumeError } = await db.rpc('resume_chatbot_nightly_review', {
                    p_review_id: review.id, p_attempt: review.attempt_count, p_state_updated_at: state.updated_at,
                    p_pipeline_updated_at: contact.pipeline_stage_updated_at, p_last_inbound_at: contact.last_inbound_at,
                    p_config_updated_at: config.updated_at, p_automation_epoch: state.automation_epoch,
                    p_last_human_activity_at: state.last_human_activity_at, p_collected_details: extracted.collected_details,
                    p_missing_details: decision.missing_details, p_request_type: requestType, p_has_clear_request: hasClearRequest,
                    p_request_evidence: requestEvidence, p_analysis: analysis,
                    p_now: input.now ? now.toISOString() : new Date().toISOString()
                });
                if (resumeError) throw new Error(resumeError.message);
                if (resumed) result.resumed++;
                else { await mark(review, { status: review.attempt_count >= 3 ? 'failed' : 'pending', analysis,
                    error_message: 'Nightly snapshot changed during review; recheck current state' }); result.skipped++; }
                continue;
            }
            const target = state && config ? getContinuationDetailTarget(config.details_to_collect, state.collected_details) : null;
            if (!page?.access_token || !contact?.psid || !config?.enabled || !config.follow_up_enabled || !config.continuation_review_enabled ||
                isCommercialVideoIntake(config) || !isChatbotContactAllowed(config, review.contact_id) || state?.status !== 'stopped' || state.stop_reason !== 'details_collected' ||
                state.collection_round !== review.collection_round || contact.pipeline_stage !== 'qualified' || contact.pipeline_stage_source !== 'chatbot' || !target) {
                await mark(review, { status: 'skipped', error_message: 'No longer eligible or no missing details remain' }); result.skipped++; continue;
            }
            const conversation = await getConversationForPsid(page.fb_page_id, contact.psid, page.access_token, { throwOnError: true, timeoutMs: 5000 });
            const history = await loadMessengerHistoryForStopCheck({ facebookPageId: page.fb_page_id, accessToken: page.access_token,
                initialPage: conversation?.messages, requireAvailable: true, ...getChatbotHandoffOptions(state) });
            const signal = findLatestMessengerSystemSignal(history, page.fb_page_id, getChatbotHandoffOptions(state));
            if (signal) {
                await saveChatbotContactState(db, { pageId: review.page_id, contactId: review.contact_id, existingState: state, stopReason: signal, now });
                await updateContactPipelineStage(db, { pageId: review.page_id, contactId: review.contact_id, stage: pipelineStageForMessengerSignal(signal), source: 'messenger', now });
                await mark(review, { status: 'kept_stopped', error_message: `Messenger handoff: ${signal}` }); result.keptStopped++; continue;
            }
            const readable: FacebookMessage[] = history.flatMap(m => m.from?.id ? [{ id: m.id || '', message: m.message || '',
                created_time: m.created_time || '', from: { id: m.from.id, name: m.from.name || '' } }] : []);
            const latestCustomer = readable.filter(m => m.from.id !== page.fb_page_id && m.message?.trim())
                .sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time))[0];
            if (!latestCustomer || classifyChatbotStopIntent(latestCustomer.message || '', { stopOnOptOut: true, stopOnRefusal: true })) {
                await mark(review, { status: 'kept_stopped', error_message: 'No readable customer interest or customer declined' }); result.keptStopped++; continue;
            }
            const analysis = await analyzeChatbotContinuation({ config, pageId: page.fb_page_id, history: readable, collectedDetails: state.collected_details });
            if (analysis.purchase_status !== 'undecided' || analysis.confidence < 0.8) {
                await mark(review, { status: 'kept_stopped', analysis }); result.keptStopped++; continue;
            }
            const { data: resumed, error: resumeError } = await db.rpc('resume_chatbot_continuation_review', {
                p_review_id: review.id, p_attempt: review.attempt_count, p_state_updated_at: state.updated_at,
                p_pipeline_updated_at: contact.pipeline_stage_updated_at, p_last_inbound_at: contact.last_inbound_at,
                p_target: target, p_analysis: analysis, p_now: new Date(Math.max(now.getTime(), Date.now())).toISOString()
            });
            if (resumeError) throw new Error(resumeError.message);
            if (resumed) result.resumed++;
            else { await mark(review, { status: 'skipped', analysis, error_message: 'Eligibility changed during analysis' }); result.skipped++; }
        } catch (error) {
            await mark(review, { status: review.attempt_count >= 3 ? 'failed' : 'pending', error_message: (error instanceof Error ? error.message : String(error)).slice(0, 1000) });
            result.failed++;
        }
    }
    return result;
}
