import { getConversationForPsid } from '@/lib/facebook';
import { getChatbotContactState, saveChatbotContactState, isChatbotContactAllowed } from '@/lib/chatbot-control';
import { isPipelineClosedForAutomation, updateContactPipelineStage } from '@/lib/contact-pipeline';
import { findLatestMessengerSystemSignal } from '@/lib/messaging-auto-tag';

export class ChatbotDeliveryStoppedError extends Error {}

/** Check immediately before each bubble/card, including changes made during generation. */
export async function assertChatbotDeliveryAllowed(input: {
    supabase: { from: (table: string) => any };
    pageId: string;
    facebookPageId: string;
    accessToken: string;
    contactId: string;
    psid: string;
    allowCompletedPhoto?: boolean;
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
        const completedPhoto = input.allowCompletedPhoto && state?.stop_reason === 'details_collected' &&
            contact?.pipeline_stage === 'qualified' && contact.pipeline_stage_source === 'chatbot';
        if (!contact || !config?.enabled || !isChatbotContactAllowed(config, input.contactId) ||
            (input.followUpJobId && jobResult?.data?.status !== 'processing') ||
            (input.followUp && !config.follow_up_enabled) ||
            (!completedPhoto && (state?.status === 'stopped' || isPipelineClosedForAutomation(contact.pipeline_stage))) ||
            (input.anchorInboundAt && new Date(contact.last_inbound_at || 0).getTime() > new Date(input.anchorInboundAt).getTime())) {
            throw new ChatbotDeliveryStoppedError('Chatbot eligibility changed; automatic delivery cancelled');
        }
        return state;
    };
    const state = await checkSavedEligibility();

    // The initial eligibility check has already scanned older history. This fresh
    // page detects handoffs made while the AI or a previous bubble was running.
    const conversation = await getConversationForPsid(input.facebookPageId, input.psid, input.accessToken,
        { throwOnError: true, timeoutMs: 5000 });
    const signal = findLatestMessengerSystemSignal(conversation?.messages?.data || [], input.facebookPageId);
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
    await updateContactPipelineStage(db, { pageId: input.pageId, contactId: input.contactId, stage: signal, source: 'messenger' });
    throw new ChatbotDeliveryStoppedError(`Messenger lead stage: ${signal}; automatic delivery cancelled`);
}
