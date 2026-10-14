export type MessengerSystemSignal = 'order_created' | 'qualified' | 'not_qualified' | 'converted' | 'manual';

export type MessengerHistoryMessage = {
    id?: string;
    message?: string;
    from?: { id?: string; name?: string };
    created_time?: string;
    tags?: { data?: Array<{ name?: string }> };
};

export type MessengerLeadStageEvent = {
    messageId: string;
    signal: MessengerSystemSignal;
    createdTime: string | null;
};

/** Meta emits this administrative event as a Page echo; it is not a staff reply. */
export function isMessengerAutomaticNotice(text: string): boolean {
    return /^This message was automatically moved to spam\.?$/i.test(text.trim());
}

/** Look past the first 100 messages so old handoffs remain effective. */
export async function loadMessengerHistoryForStopCheck(input: {
    facebookPageId: string;
    accessToken: string;
    initialPage?: { data?: MessengerHistoryMessage[]; paging?: { next?: string } } | null;
    maxPages?: number;
    requireAvailable?: boolean;
    humanHandoffSince?: string | null;
}): Promise<MessengerHistoryMessage[]> {
    if (input.requireAvailable && !Array.isArray(input.initialPage?.data)) {
        throw new Error('Messenger lead-stage history is unavailable; automatic delivery blocked');
    }
    const messages = [...(input.initialPage?.data || [])];
    let next = input.initialPage?.paging?.next;
    const seen = new Set<string>();
    const deadline = Date.now() + 20_000;
    const maxPages = input.maxPages ?? 10;
    for (let page = 1; next && !findLatestMessengerSystemSignal(messages, input.facebookPageId, input); page++) {
        if (page >= maxPages || Date.now() >= deadline) {
            throw new Error('Messenger lead-stage history check exceeded its safe limit');
        }
        const url = new URL(next);
        if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com' || seen.has(next)) {
            throw new Error('Unexpected Messenger lead-stage pagination URL');
        }
        seen.add(next);
        url.searchParams.delete('access_token');
        url.searchParams.set('fields', 'id,message,from,created_time,tags');
        const response = await fetch(url, {
            cache: 'no-store',
            headers: { Authorization: `Bearer ${input.accessToken}` },
            signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now())))
        });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error?.message || 'Could not verify Messenger lead-stage history');
        if (!Array.isArray(body.data)) throw new Error('Messenger lead-stage history is unavailable');
        messages.push(...body.data);
        next = body.paging?.next;
    }
    return messages;
}

// These are Meta-generated conversation-history messages, not customer/staff prose.
// The stage and order text was observed in the app's read-only Messenger audit.
export function classifyMessengerSystemMessage(text: string): MessengerSystemSignal | null {
    const value = text.trim();
    const stage = /^Lead stage set to ([^\r\n]{1,80}?)\.?$/i.exec(value);
    if (stage) {
        const normalized = stage[1].trim().toLowerCase().replace(/\s+/g, '_');
        if (normalized === 'disqualified' || normalized === 'unqualified') return 'not_qualified';
        if (['qualified', 'not_qualified', 'converted', 'order_created'].includes(normalized)) return normalized as MessengerSystemSignal;
        // Intake, Contacted and custom Lead Center stages are human handoffs too.
        return 'manual';
    }

    // Observed in live Onset history when a person takes over in Business Suite.
    if (/^You took over this chat from your AI agent\.?$/i.test(value)) return 'manual';

    if (/^You (?:created an order for|requested) (?:PHP|\u20B1)[\d,.]+\b/i.test(value) &&
        /fb-pma:\/\/payments\/orderdetails\/\?[^\s]*invoice_id=\d+/i.test(value)) {
        return 'order_created';
    }

    return null;
}

export function classifyMessengerHistoryMessage(
    message: MessengerHistoryMessage,
    facebookPageId: string,
    options: { humanHandoffSince?: string | null } = {}
): MessengerSystemSignal | null {
    if (message.from?.id !== facebookPageId) return null;
    if (isMessengerAutomaticNotice(message.message || '')) return null;
    const signal = typeof message.message === 'string' ? classifyMessengerSystemMessage(message.message) : null;
    // Explicit lead stages/orders remain durable. Ordinary staff replies belong
    // to the current intake, so an old chat does not undo an explicit bot reset.
    const isHumanHandoff = signal === 'manual' && !/^Lead stage set to /i.test(message.message?.trim() || '');
    if (signal && !isHumanHandoff) return signal;
    const since = new Date(options.humanHandoffSince || '').getTime();
    const sentAt = new Date(message.created_time || '').getTime();
    if (Number.isFinite(since) && Number.isFinite(sentAt) && sentAt < since) return null;
    if (signal) return signal;
    // Live Meta reads mark staff mobile replies source:mobile, including photos.
    // VeoBot API messages are source:web; source:web alone is not a handoff.
    return message.tags?.data?.some(tag => tag.name === 'source:mobile') ? 'manual' : null;
}

/** Find the newest lead-stage or human-handoff event in a Messenger thread. */
export function findLatestMessengerSystemSignal(
    messages: MessengerHistoryMessage[],
    facebookPageId: string,
    options: { humanHandoffSince?: string | null } = {}
): MessengerSystemSignal | null {
    const matches = messages.flatMap((message, index) => {
        const signal = classifyMessengerHistoryMessage(message, facebookPageId, options);
        if (!signal) return [];
        const timestamp = typeof message.created_time === 'string'
            ? new Date(message.created_time).getTime()
            : Number.NaN;
        return [{ signal, index, timestamp }];
    });

    if (matches.length === 0) return null;
    matches.sort((left, right) => {
        const leftHasTimestamp = Number.isFinite(left.timestamp);
        const rightHasTimestamp = Number.isFinite(right.timestamp);
        if (leftHasTimestamp && rightHasTimestamp && left.timestamp !== right.timestamp) {
            return right.timestamp - left.timestamp;
        }
        if (leftHasTimestamp !== rightHasTimestamp) return leftHasTimestamp ? -1 : 1;
        // Facebook currently returns conversation history newest-first.
        return left.index - right.index;
    });
    return matches[0].signal;
}

/** Find the newest explicit Lead Center stage change and keep its audit metadata. */
export function findLatestMessengerLeadStageEvent(
    messages: MessengerHistoryMessage[],
    facebookPageId: string
): MessengerLeadStageEvent | null {
    const matches = messages.flatMap((message, index) => {
        if (
            message.from?.id !== facebookPageId ||
            typeof message.id !== 'string' ||
            !message.id.trim() ||
            typeof message.message !== 'string' ||
            !/^Lead stage set to /i.test(message.message.trim())
        ) return [];
        const signal = classifyMessengerSystemMessage(message.message);
        if (!signal) return [];
        const timestamp = typeof message.created_time === 'string'
            ? new Date(message.created_time).getTime()
            : Number.NaN;
        return [{
            messageId: message.id.trim(),
            signal,
            createdTime: message.created_time || null,
            index,
            timestamp
        }];
    });

    if (matches.length === 0) return null;
    matches.sort((left, right) => {
        const leftHasTimestamp = Number.isFinite(left.timestamp);
        const rightHasTimestamp = Number.isFinite(right.timestamp);
        if (leftHasTimestamp && rightHasTimestamp && left.timestamp !== right.timestamp) {
            return right.timestamp - left.timestamp;
        }
        if (leftHasTimestamp !== rightHasTimestamp) return leftHasTimestamp ? -1 : 1;
        return left.index - right.index;
    });
    const latest = matches[0];
    return {
        messageId: latest.messageId,
        signal: latest.signal,
        createdTime: latest.createdTime
    };
}
