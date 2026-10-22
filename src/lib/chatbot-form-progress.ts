import { getChatbotContactState, getMissingChatbotDetails, normalizeCollectedChatbotDetails, normalizeDetailsToCollect, saveChatbotContactState, type ChatbotContactState } from '@/lib/chatbot-control';
import { COMMERCIAL_VIDEO_REQUIRED_DETAILS, extractCommercialVideoFormDetails, getMissingCommercialVideoDetails, normalizeCommercialVideoDetails } from '@/lib/chatbot-intake';
import { updateContactPipelineStage } from '@/lib/contact-pipeline';

type DetailConfig = { commercial_video_intake_enabled?: boolean; details_to_collect?: unknown };

/** Form completion is independent of the lead stage and cached missing list. */
export function getChatbotDetailProgress(config: DetailConfig | null, details: unknown) {
    const commercial = config?.commercial_video_intake_enabled === true;
    const saved = normalizeCollectedChatbotDetails(details);
    const collected = commercial ? normalizeCommercialVideoDetails(details) : saved;
    // Older conversations can contain useful answers beyond today's form.
    // Display them while counting only valid required answers for completion.
    const displayed = commercial ? {
        ...Object.fromEntries(Object.entries(saved).filter(([key, value]) => !Object.keys(normalizeCommercialVideoDetails({ [key]: value })).length)),
        ...collected
    } : collected;
    const required = commercial ? [...COMMERCIAL_VIDEO_REQUIRED_DETAILS] : normalizeDetailsToCollect(config?.details_to_collect);
    const missing = commercial ? getMissingCommercialVideoDetails(collected) : getMissingChatbotDetails(required, collected);
    return { collected_details: displayed, collected_count: required.filter(label => !missing.includes(label)).length,
        saved_count: Object.keys(displayed).length, required_count: required.length, missing_details: missing,
        complete: required.length > 0 && missing.length === 0 };
}

/** Save form answers before generation/delivery, without introducing a stop. */
export async function captureCommercialVideoFormProgress(db: { from: (table: string) => any }, input: {
    pageId: string; contactId: string; existingState: ChatbotContactState | null; customerText: string; inboundAt: string;
}): Promise<ChatbotContactState | null> {
    const submitted = extractCommercialVideoFormDetails(input.customerText);
    if (!Object.keys(submitted).length) return input.existingState;
    const collectedDetails = { ...normalizeCommercialVideoDetails(input.existingState?.collected_details), ...submitted };
    await saveChatbotContactState(db, { pageId: input.pageId, contactId: input.contactId, existingState: input.existingState,
        collectedDetails, missingDetails: getMissingCommercialVideoDetails(collectedDetails), inboundAt: input.inboundAt });
    // A delivery rejection must not hide partial answers from the client list.
    // Existing manual/Messenger stages and every stopped state retain ownership.
    if (input.existingState?.status !== 'stopped') {
        try { await updateContactPipelineStage(db, { pageId: input.pageId, contactId: input.contactId, stage: 'collecting_details', source: 'chatbot' }); }
        catch (error) { console.warn('[CHATBOT_FORM_PROGRESS_PIPELINE]', error instanceof Error ? error.message : 'Could not update pipeline'); }
    }
    return await getChatbotContactState(db, input.pageId, input.contactId);
}
