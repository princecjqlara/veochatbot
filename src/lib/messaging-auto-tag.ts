export type MessengerSystemSignal = 'order_created' | 'qualified' | 'not_qualified' | 'converted';

type MessengerHistoryMessage = {
    message?: string;
    from?: { id?: string };
    created_time?: string;
};

// These are Meta-generated conversation-history messages, not customer/staff prose.
// The stage and order text was observed in the app's read-only Messenger audit.
export function classifyMessengerSystemMessage(text: string): MessengerSystemSignal | null {
    const value = text.trim();
    const stage = /^Lead stage set to (Qualified|Not Qualified|Disqualified|Converted|Order Created)\.?$/i.exec(value);
    if (stage) {
        const normalized = stage[1].toLowerCase().replace(/\s+/g, '_');
        return normalized === 'disqualified' ? 'not_qualified' : normalized as MessengerSystemSignal;
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
