import { getConversationForPsid } from '@/lib/facebook';
import { getChatbotContactState, getChatbotHandoffOptions, saveChatbotContactState, isChatbotContactAllowed } from '@/lib/chatbot-control';
import { isPipelineClosedForAutomation, pipelineStageForMessengerSignal, updateContactPipelineStage } from '@/lib/contact-pipeline';
import { findLatestMessengerSystemSignal, getMessengerHandoffMetadata, loadMessengerHistoryForStopCheck } from '@/lib/messaging-auto-tag';

export class ChatbotDeliveryStoppedError extends Error {}

/** Check immediately before each bubble/card, including changes made during generation. */
export async function assertChatbotDeliveryAllowed(input: {
    supabase: { from: (table: string) => any };
    pageId: string;
    facebookPageId: string;
    accessToken: string;
    contactId: string;
    psid: string;
    anchorInboundAt?: string;
    followUp?: boolean;
    followUpJobId?: string;
    automationEpoch?: number;
    policyRevision?: number;
    /** Workflow/welcome sends share stop rules without requiring the AI bot to be enabled. */
    enforceChatbotSettings?: boolean;
}): Promise<void> {
    const db = input.supabase;
    const enforceChatbotSettings = input.enforceChatbotSettings !== false;
    const checkSavedEligibility = async () => {
        const [contactResult, configResult, state, jobResult] = await Promise.all([
            db.from('contacts').select('pipeline_stage,pipeline_stage_source,last_inbound_at')
                .eq('page_id', input.pageId).eq('id', input.contactId).maybeSingle(),
            enforceChatbotSettings ? db.from('chatbot_configs').select('enabled,follow_up_enabled,trial_mode_enabled,trial_contact_id,commercial_video_intake_enabled,policy_revision')
                .eq('page_id', input.pageId).maybeSingle() : null,
            getChatbotContactState(db, input.pageId, input.contactId),
            input.followUpJobId ? db.from('chatbot_follow_up_jobs').select('status')
                .eq('id', input.followUpJobId).eq('page_id', input.pageId).eq('contact_id', input.contactId).maybeSingle() : null
        ]);
        if (contactResult.error) throw new Error(contactResult.error.message);
        if (configResult?.error) throw new Error(configResult.error.message);
        if (jobResult?.error) throw new Error(jobResult.error.message);
        const contact = contactResult.data;
        const config = configResult?.data;
        if (!contact || (enforceChatbotSettings && (!config?.enabled || !isChatbotContactAllowed(config, input.contactId))) ||
            (input.followUpJobId && jobResult?.data?.status !== 'processing') ||
            (input.followUp && enforceChatbotSettings && !config?.follow_up_enabled) ||
            state?.status === 'stopped' || isPipelineClosedForAutomation(contact?.pipeline_stage, contact?.pipeline_stage_source, config) ||
            (input.automationEpoch !== undefined && (state?.automation_epoch || 0) !== input.automationEpoch) ||
            (input.policyRevision !== undefined && (config?.policy_revision || 1) !== input.policyRevision) ||
            (input.anchorInboundAt && new Date(contact.last_inbound_at || 0).getTime() > new Date(input.anchorInboundAt).getTime())) {
            throw new ChatbotDeliveryStoppedError('Chatbot eligibility changed; automatic delivery cancelled');
        }
        return state;
    };
    const state = await checkSavedEligibility();

    // Refresh the complete bounded audit, including changes during generation.
    const conversation = await getConversationForPsid(input.facebookPageId, input.psid, input.accessToken,
        { throwOnError: true, timeoutMs: 5000 });
    let history;
    try {
        history = await loadMessengerHistoryForStopCheck({ facebookPageId: input.facebookPageId,
            accessToken: input.accessToken, initialPage: conversation?.messages, requireAvailable: true,
            ...getChatbotHandoffOptions(state, input.anchorInboundAt) });
    } catch (error) {
        await checkSavedEligibility();
        throw error;
    }
    const handoffOptions = getChatbotHandoffOptions(state, input.anchorInboundAt);
    const signal = findLatestMessengerSystemSignal(history, input.facebookPageId, handoffOptions);
    if (!signal) {
        // A stop can also arrive while the Graph read is in flight.
        await checkSavedEligibility();
        return;
    }
    await saveChatbotContactState(db, { pageId: input.pageId, contactId: input.contactId, existingState: state,
        stopReason: signal, ...getMessengerHandoffMetadata(history, input.facebookPageId, handoffOptions) });
    const { error } = await db.from('chatbot_follow_up_jobs')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), claimed_at: null })
        .eq('page_id', input.pageId).eq('contact_id', input.contactId).in('status', ['pending', 'processing', 'ready_manual']);
    if (error) throw new Error(error.message);
    await updateContactPipelineStage(db, { pageId: input.pageId, contactId: input.contactId, stage: pipelineStageForMessengerSignal(signal), source: 'messenger' });
    throw new ChatbotDeliveryStoppedError(`Messenger lead stage: ${signal}; automatic delivery cancelled`);
}

/** All non-campaign automatic sends must honor saved and live Messenger handoffs. */
export async function assertMessengerAutomationDeliveryAllowed(
    input: Omit<Parameters<typeof assertChatbotDeliveryAllowed>[0], 'enforceChatbotSettings' | 'followUp' | 'followUpJobId'>
): Promise<void> {
    await assertChatbotDeliveryAllowed({ ...input, enforceChatbotSettings: false });
}
