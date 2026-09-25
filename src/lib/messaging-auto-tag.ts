export type MessengerSystemSignal = 'order_created' | 'qualified' | 'not_qualified' | 'converted';

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
