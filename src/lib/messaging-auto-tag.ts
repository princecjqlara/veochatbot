export type MessengerSystemSignal = 'order_created' | 'qualified' | 'not_qualified' | 'converted' | 'manual';

type MessengerHistoryMessage = {
    id?: string;
    message?: string;
    from?: { id?: string };
    created_time?: string;
};

export type MessengerLeadStageEvent = {
    messageId: string;
    signal: MessengerSystemSignal;
    createdTime: string | null;
};

/** Look past the first 100 messages so old handoffs remain effective. */
export async function loadMessengerHistoryForStopCheck(input: {
    facebookPageId: string;
    accessToken: string;
    initialPage?: { data?: MessengerHistoryMessage[]; paging?: { next?: string } } | null;
    maxPages?: number;
    requireAvailable?: boolean;
}): Promise<MessengerHistoryMessage[]> {
    if (input.requireAvailable && !Array.isArray(input.initialPage?.data)) {
        throw new Error('Messenger lead-stage history is unavailable; automatic delivery blocked');
    }
    const messages = [...(input.initialPage?.data || [])];
    let next = input.initialPage?.paging?.next;
    const seen = new Set<string>();
    const deadline = Date.now() + 20_000;
    const maxPages = input.maxPages ?? 10;
    for (let page = 1; next && !findLatestMessengerSystemSignal(messages, input.facebookPageId); page++) {
        if (page >= maxPages || Date.now() >= deadline) {
            throw new Error('Messenger lead-stage history check exceeded its safe limit');
        }
        const url = new URL(next);
        if (url.protocol !== 'https:' || url.hostname !== 'graph.facebook.com' || seen.has(next)) {
            throw new Error('Unexpected Messenger lead-stage pagination URL');
        }
        seen.add(next);
        url.searchParams.delete('access_token');
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

    if (/^You (?:created an order for|requested) (?:PHP|\u20B1)[\d,.]+\b/i.test(value) &&
        /fb-pma:\/\/payments\/orderdetails\/\?[^\s]*invoice_id=\d+/i.test(value)) {
        return 'order_created';
    }

    return null;
}

/** Find the newest terminal Lead Center event written into a Messenger thread. */
export function findLatestMessengerSystemSignal(
    messages: MessengerHistoryMessage[],
    facebookPageId: string
): MessengerSystemSignal | null {
    const matches = messages.flatMap((message, index) => {
        if (message.from?.id !== facebookPageId || typeof message.message !== 'string') return [];
        const signal = classifyMessengerSystemMessage(message.message);
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
