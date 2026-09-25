export const CHATBOT_CONVERSATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ChatbotStopReason =
    | 'details_collected'
    | 'opt_out'
    | 'refusal'
    | 'qualified'
    | 'not_qualified'
    | 'converted'
    | 'order_created'
    | 'window_expired'
    | 'manual';

export type ChatbotContactState = {
    id?: string;
    page_id: string;
    contact_id: string;
    status: 'active' | 'stopped';
    started_at: string;
    window_expires_at: string;
    collected_details: Record<string, string>;
    missing_details: string[];
    stop_reason: ChatbotStopReason | null;
    stopped_at: string | null;
    last_inbound_at: string | null;
    last_bot_reply_at: string | null;
};

type SupabaseLike = {
    from: (table: string) => any;
};

const OPT_OUT_PATTERNS = [
    /\bstop\b/i,
    /\bunsubscribe\b/i,
    /\bremove me\b/i,
    /\bdo not (?:message|contact|text|reply)\b/i,
    /\bdon't (?:message|contact|text|reply)\b/i,
    /\bleave me alone\b/i,
    /\bno more messages?\b/i,
    /\btama na(?: ang)? (?:message|chat)\b/i,
    /\bhuwag (?:mo )?(?:akong )?(?:i-message|imessage|kontakin|kausapin)\b/i
];

const REFUSAL_PATTERNS = [
    /\bnot interested\b/i,
    /\bno thanks?\b/i,
    /\bno thank you\b/i,
    /\bi(?:'m| am) not buying\b/i,
    /\bi (?:do not|don't) want (?:it|this|that|to buy)\b/i,
    /\bpass(?: muna)?\b/i,
    /\bayoko\b/i,
    /\bhindi ako interesado\b/i,
    /\bdi ako interesado\b/i,
    /\bwag na\b/i,
    /\bhuwag na\b/i
];

export function normalizeDetailsToCollect(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const details: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const normalized = item.trim().replace(/\s+/g, ' ').slice(0, 80);
        const key = normalized.toLowerCase();
        if (!normalized || seen.has(key)) continue;
        seen.add(key);
        details.push(normalized);
        if (details.length >= 20) break;
    }
    return details;
}

export function classifyChatbotStopIntent(
    messageText: string,
    options: { stopOnOptOut: boolean; stopOnRefusal: boolean }
): ChatbotStopReason | null {
    const value = messageText.trim();
    if (!value) return null;
    if (options.stopOnOptOut && OPT_OUT_PATTERNS.some((pattern) => pattern.test(value))) {
        return 'opt_out';
    }
    if (options.stopOnRefusal && REFUSAL_PATTERNS.some((pattern) => pattern.test(value))) {
        return 'refusal';
    }
    return null;
}

export function getMissingChatbotDetails(
    detailsToCollect: string[],
    collectedDetails: Record<string, string>
): string[] {
    const collectedKeys = new Set(
        Object.entries(collectedDetails)
            .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
            .map(([key]) => key.trim().toLowerCase())
    );
    return normalizeDetailsToCollect(detailsToCollect)
        .filter((detail) => !collectedKeys.has(detail.toLowerCase()));
}

export function normalizeChatbotDetailTargetPercent(value: unknown): number {
    const numeric = Math.round(Number(value));
    return Number.isFinite(numeric) ? Math.min(100, Math.max(1, numeric)) : 100;
}

export function getRequiredChatbotDetailCount(totalDetails: number, targetPercent: unknown): number {
    if (totalDetails <= 0) return 0;
    return Math.max(1, Math.ceil(totalDetails * normalizeChatbotDetailTargetPercent(targetPercent) / 100));
}

function normalizeCollectedDetails(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter((entry): entry is [string, string] =>
                typeof entry[1] === 'string' && entry[1].trim().length > 0
            )
            .map(([key, detail]) => [key.trim().slice(0, 80), detail.trim().slice(0, 500)])
            .filter(([key]) => key.length > 0)
            .slice(0, 20)
    );
}

export async function getChatbotContactState(
    supabase: SupabaseLike,
    pageId: string,
    contactId: string
): Promise<ChatbotContactState | null> {
    const { data, error } = await supabase
        .from('chatbot_contact_states')
        .select('id, page_id, contact_id, status, started_at, window_expires_at, collected_details, missing_details, stop_reason, stopped_at, last_inbound_at, last_bot_reply_at')
        .eq('page_id', pageId)
        .eq('contact_id', contactId)
        .maybeSingle();
    if (error) throw new Error(error.message || 'Could not load chatbot contact state');
    if (!data) return null;
    return {
        ...data,
        collected_details: normalizeCollectedDetails(data.collected_details),
        missing_details: normalizeDetailsToCollect(data.missing_details)
    } as ChatbotContactState;
}

export async function saveChatbotContactState(
    supabase: SupabaseLike,
    input: {
        pageId: string;
        contactId: string;
        existingState?: ChatbotContactState | null;
        collectedDetails?: Record<string, string>;
        missingDetails?: string[];
        inboundAt?: string;
        botRepliedAt?: string;
        stopReason?: ChatbotStopReason | null;
        now?: Date;
    }
): Promise<void> {
    const now = input.now || new Date();
    const startedAt = input.existingState?.started_at || now.toISOString();
    const activityAnchor = input.inboundAt || startedAt;
    const activityAnchorTime = new Date(activityAnchor).getTime();
    const expiresAt = Number.isFinite(activityAnchorTime)
        ? new Date(activityAnchorTime + CHATBOT_CONVERSATION_WINDOW_MS).toISOString()
        : new Date(now.getTime() + CHATBOT_CONVERSATION_WINDOW_MS).toISOString();
    const stopReason = input.stopReason || null;
    const payload = {
        page_id: input.pageId,
        contact_id: input.contactId,
        status: stopReason ? 'stopped' : 'active',
        started_at: startedAt,
        window_expires_at: expiresAt,
        collected_details: normalizeCollectedDetails({
            ...(input.existingState?.collected_details || {}),
            ...(input.collectedDetails || {})
        }),
        missing_details: normalizeDetailsToCollect(input.missingDetails || input.existingState?.missing_details || []),
        stop_reason: stopReason,
        stopped_at: stopReason ? now.toISOString() : null,
        last_inbound_at: input.inboundAt || input.existingState?.last_inbound_at || null,
        last_bot_reply_at: input.botRepliedAt || input.existingState?.last_bot_reply_at || null,
        updated_at: now.toISOString()
    };
    const { error } = await supabase
        .from('chatbot_contact_states')
        .upsert(payload, { onConflict: 'page_id,contact_id' });
    if (error) throw new Error(error.message || 'Could not save chatbot contact state');
}

export function getChatbotStateStopReason(
    state: ChatbotContactState | null,
    now: Date = new Date()
): ChatbotStopReason | null {
    if (!state) return null;
    if (state.status === 'stopped') return state.stop_reason || 'manual';
    const expiresAt = new Date(state.window_expires_at).getTime();
    if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) return 'window_expired';
    return null;
}
