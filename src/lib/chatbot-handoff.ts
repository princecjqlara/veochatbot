import { getChatbotContactState, saveChatbotContactState } from '@/lib/chatbot-control';
import { cancelPendingChatbotFollowUps } from '@/lib/chatbot-follow-ups';
import { isContactPipelineStage, updateContactPipelineStage } from '@/lib/contact-pipeline';

/** Persist human ownership before calling Meta, whose API echo looks automated. */
export async function stopChatbotForManualReply(input: {
    supabase: { from: (table: string) => any };
    pageId: string;
    contactId: string;
    followUpJobId?: string | null;
}) {
    const { supabase, pageId, contactId } = input;
    const [contactResult, state] = await Promise.all([
        supabase.from('contacts').select('pipeline_stage,pipeline_stage_source')
            .eq('page_id', pageId).eq('id', contactId).maybeSingle(),
        getChatbotContactState(supabase, pageId, contactId)
    ]);
    if (contactResult.error) throw new Error(contactResult.error.message);
    if (!contactResult.data) throw new Error('Contact unavailable before manual handoff');
    await saveChatbotContactState(supabase, {
        pageId, contactId, existingState: state,
        stopReason: state?.status === 'stopped' ? state.stop_reason || 'manual' : 'manual'
    });
    await cancelPendingChatbotFollowUps({
        supabase, pageId, contactId, reason: 'Staff replied in VeoBot', exceptJobId: input.followUpJobId || undefined
    });
    await updateContactPipelineStage(supabase, {
        pageId, contactId, source: 'manual', preserveStage: true,
        stage: isContactPipelineStage(contactResult.data.pipeline_stage) ? contactResult.data.pipeline_stage : 'engaged'
    });
    return state;
}
