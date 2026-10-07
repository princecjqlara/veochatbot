export type OutboundMessageSource = 'manual' | 'campaign' | 'automation' | 'welcome' | 'chatbot';

type SupabaseLike = {
    from: (table: string) => any;
};

export type OutboundMessageEventInput = {
    pageId: string;
    contactId?: string | null;
    messageId: string;
    sourceType: OutboundMessageSource;
    sourceId?: string | null;
    sourceName?: string | null;
    actorUserId?: string | null;
    actorName?: string | null;
    messageKind?: string | null;
    sentAt?: string;
};

export type ChatbotInterruptionInput = {
    pageId: string;
    contactId: string;
    messageId: string;
    source: 'veobot' | 'business_suite';
    interruptionType: 'manual_message' | 'lead_stage_change';
    actorUserId?: string | null;
    actorName?: string | null;
    leadStage?: string | null;
    interruptedAt?: string;
    stateBeforeStop?: ChatbotInterruptionState | null;
};

type ChatbotInterruptionConfig = {
    details_to_collect?: unknown;
    details_completion_percent?: unknown;
};

type ChatbotInterruptionState = {
    status?: unknown;
    collected_details?: unknown;
};

let hasWarnedAboutAttributionFailure = false;

function warnOnce(error: unknown) {
    if (hasWarnedAboutAttributionFailure) return;
    hasWarnedAboutAttributionFailure = true;
    console.warn(
        '[OUTBOUND_MESSAGE_EVENT] Failed to record message attribution:',
        error instanceof Error ? error.message : error
    );
}

function normalizeRequestedDetails(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.flatMap((item) => {
        if (typeof item !== 'string') return [];
        const detail = item.trim().replace(/\s+/g, ' ').slice(0, 80);
        const key = detail.toLowerCase();
        if (!detail || seen.has(key)) return [];
        seen.add(key);
        return [detail];
    }).slice(0, 20);
}

function countCollectedDetails(
    requestedDetails: string[],
    collectedDetails: unknown
): number {
    if (!collectedDetails || typeof collectedDetails !== 'object' || Array.isArray(collectedDetails)) {
        return 0;
    }
    const values = new Map(
        Object.entries(collectedDetails as Record<string, unknown>)
            .filter((entry): entry is [string, string] =>
                typeof entry[1] === 'string' && entry[1].trim().length > 0
            )
            .map(([key, value]) => [key.trim().toLowerCase(), value.trim()])
    );
    return requestedDetails.filter((detail) => values.has(detail.toLowerCase())).length;
}

export async function recordChatbotInterruptionIfNeeded(
    supabase: SupabaseLike,
    event: ChatbotInterruptionInput
): Promise<void> {
    if (!event.contactId || !event.messageId?.trim()) return;

    const [configResult, stateResult] = await Promise.all([
        supabase
            .from('chatbot_configs')
            .select('details_to_collect, details_completion_percent')
            .eq('page_id', event.pageId)
            .maybeSingle(),
        event.stateBeforeStop !== undefined
            ? Promise.resolve({ data: event.stateBeforeStop, error: null })
            : supabase
            .from('chatbot_contact_states')
            .select('status, collected_details')
            .eq('page_id', event.pageId)
            .eq('contact_id', event.contactId)
            .maybeSingle()
    ]);

    if (configResult.error) throw configResult.error;
    if (stateResult.error) throw stateResult.error;

    const config = configResult.data as ChatbotInterruptionConfig | null;
    const state = stateResult.data as ChatbotInterruptionState | null;
    if (!config || state?.status !== 'active') return;

    const requestedDetails = normalizeRequestedDetails(config.details_to_collect);
    if (requestedDetails.length === 0) return;

    const targetPercent = Math.min(100, Math.max(
        1,
        Math.round(Number(config.details_completion_percent) || 100)
    ));
    const requiredDetailCount = Math.max(1, Math.ceil(requestedDetails.length * targetPercent / 100));
    const collectedDetailCount = countCollectedDetails(requestedDetails, state.collected_details);
    if (collectedDetailCount >= requiredDetailCount) return;

    const { error } = await supabase
        .from('chatbot_interruption_events')
        .upsert({
            page_id: event.pageId,
            contact_id: event.contactId,
            message_id: event.messageId.trim(),
            actor_user_id: event.actorUserId || null,
            actor_name: event.actorName?.trim() || null,
            source: event.source,
            interruption_type: event.interruptionType,
            lead_stage: event.leadStage?.trim() || null,
            collected_detail_count: collectedDetailCount,
            required_detail_count: requiredDetailCount,
            missing_detail_count: Math.max(0, requestedDetails.length - collectedDetailCount),
            interrupted_at: event.interruptedAt || new Date().toISOString()
        }, { onConflict: 'message_id' });

    if (error) throw error;
}

/**
 * Records enough information to attribute a Facebook Page message during export.
 * Sending must remain successful when the audit migration has not been deployed yet,
 * so audit failures are logged but never re-thrown.
 */
export async function recordOutboundMessageEvent(
    supabase: SupabaseLike,
    event: OutboundMessageEventInput
): Promise<void> {
    if (!event.messageId?.trim()) return;

    try {
        const { error } = await supabase
            .from('outbound_message_events')
            .upsert({
                page_id: event.pageId,
                contact_id: event.contactId || null,
                message_id: event.messageId,
                source_type: event.sourceType,
                source_id: event.sourceId || null,
                source_name: event.sourceName || null,
                actor_user_id: event.actorUserId || null,
                actor_name: event.actorName || null,
                message_kind: event.messageKind || null,
                sent_at: event.sentAt || new Date().toISOString()
            }, { onConflict: 'message_id' });

        if (error) {
            warnOnce(error.message);
            return;
        }

        if (event.sourceType === 'manual' && event.contactId) {
            await recordChatbotInterruptionIfNeeded(supabase, {
                pageId: event.pageId,
                contactId: event.contactId,
                messageId: event.messageId,
                source: 'veobot',
                interruptionType: 'manual_message',
                actorUserId: event.actorUserId,
                actorName: event.actorName,
                interruptedAt: event.sentAt
            });
        }
    } catch (error) {
        warnOnce(error);
    }
}
