import { getConversationForPsid } from '@/lib/facebook';
import { getChatbotContactState, saveChatbotContactState, isChatbotContactAllowed } from '@/lib/chatbot-control';
import { isPipelineClosedForAutomation, pipelineStageForMessengerSignal, updateContactPipelineStage } from '@/lib/contact-pipeline';
import { findLatestMessengerSystemSignal, loadMessengerHistoryForStopCheck } from '@/lib/messaging-auto-tag';

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
}): Promise<void> {
    const db = input.supabase;
    const checkSavedEligibility = async () => {
        const [contactResult, configResult, state, jobResult] = await Promise.all([
            db.from('contacts').select('pipeline_stage,pipeline_stage_source,last_inbound_at')
                .eq('page_id', input.pageId).eq('id', input.contactId).maybeSingle(),
            db.from('chatbot_configs').select('enabled,follow_up_enabled,trial_mode_enabled,trial_contact_id')
                .eq('page_id', input.pageId).maybeSingle(),
            getChatbotContactState(db, input.pageId, input.contactId),
            input.followUpJobId ? db.from('chatbot_follow_up_jobs').select('status')
                .eq('id', input.followUpJobId).eq('page_id', input.pageId).eq('contact_id', input.contactId).maybeSingle() : null
        ]);
        if (contactResult.error) throw new Error(contactResult.error.message);
        if (configResult.error) throw new Error(configResult.error.message);
        if (jobResult?.error) throw new Error(jobResult.error.message);
        const contact = contactResult.data;
        const config = configResult.data;
        if (!contact || !config?.enabled || !isChatbotContactAllowed(config, input.contactId) ||
            (input.followUpJobId && jobResult?.data?.status !== 'processing') ||
            (input.followUp && !config.follow_up_enabled) ||
            state?.status === 'stopped' || isPipelineClosedForAutomation(contact?.pipeline_stage, contact?.pipeline_stage_source) ||
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
            accessToken: input.accessToken, initialPage: conversation?.messages, requireAvailable: true });
    } catch (error) {
        await checkSavedEligibility();
        throw error;
    }
    const signal = findLatestMessengerSystemSignal(history, input.facebookPageId);
    if (!signal) {
        // A stop can also arrive while the Graph read is in flight.
        await checkSavedEligibility();
        return;
    }
    await saveChatbotContactState(db, { pageId: input.pageId, contactId: input.contactId, existingState: state, stopReason: signal });
    const { error } = await db.from('chatbot_follow_up_jobs')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), claimed_at: null })
        .eq('page_id', input.pageId).eq('contact_id', input.contactId).in('status', ['pending', 'processing', 'ready_manual']);
    if (error) throw new Error(error.message);
    await updateContactPipelineStage(db, { pageId: input.pageId, contactId: input.contactId, stage: pipelineStageForMessengerSignal(signal), source: 'messenger' });
    throw new ChatbotDeliveryStoppedError(`Messenger lead stage: ${signal}; automatic delivery cancelled`);
}
