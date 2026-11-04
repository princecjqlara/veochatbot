import { administrative, paymentSignal, explicitAmount } from './conversion-runtime/evidence.js';

export type ProfileMessage = { id: string; at: string; sender: 'customer' | 'page' | 'unknown'; text: string; attachments: number; images?: number };
export type PurchaseRecord = { id: string; description: string; total_minor: number; currency: string; purchased_at: string; reference?: string | null };
export type VerifiedPayment = { id: string; purchase_id: string | null; kind: 'deposit' | 'balance' | 'full' | 'refund'; amount_minor: number; currency: string; occurred_at: string; reference: string; voided_at?: string | null };
export type ProfileEvidence = { message_id: string; quote: string };
export type ProfileFact = { category: string; key: string; value: string; evidence: ProfileEvidence[] };
export type SummaryPoint = { text: string; evidence: ProfileEvidence[] };
export type ExtractedAnswer = { field: string; value: string; evidence: ProfileEvidence[] };

const at = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export const hoursBetween = (first: string | null | undefined, last: string | null | undefined) => {
    const a = at(first), b = at(last);
    return a !== null && b !== null && b >= a ? (b - a) / 3_600_000 : null;
};

export function parseMoneyMinor(value: unknown): number {
    const text = String(value ?? '').trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter a positive amount with at most two decimal places');
    const [whole, fraction = ''] = text.replaceAll(',', '').split('.');
    const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000_000_000) throw new Error('Payment amount is outside the supported range');
    return amount;
}

function orderedMessages(messages: ProfileMessage[]) {
    return [...new Map(messages.filter(message => typeof message.id === 'string' && at(message.at) !== null)
        .map(message => [message.id, message])).values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

/** All totals use staff-verified records, never tags, quotes, customer claims or AI. */
export function purchaseMetrics(purchases: PurchaseRecord[], payments: VerifiedPayment[], firstInquiryAt: string | null) {
    const valid = payments.filter(payment => !payment.voided_at && Number.isSafeInteger(Number(payment.amount_minor)) && Number(payment.amount_minor) > 0 && at(payment.occurred_at) !== null)
        .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id.localeCompare(b.id));
    const totals = new Map<string, { received_minor: number; refunded_minor: number; net_minor: number }>();
    for (const payment of valid) {
        const total = totals.get(payment.currency) || { received_minor: 0, refunded_minor: 0, net_minor: 0 };
        if (payment.kind === 'refund') total.refunded_minor += Number(payment.amount_minor);
        else total.received_minor += Number(payment.amount_minor);
        total.net_minor = total.received_minor - total.refunded_minor;
        totals.set(payment.currency, total);
    }
    const orders = purchases.map(purchase => {
        const entries = valid.filter(payment => payment.purchase_id === purchase.id && payment.currency === purchase.currency);
        let net = 0, firstFullAt: string | null = null;
        for (const entry of entries) {
            net += Number(entry.amount_minor) * (entry.kind === 'refund' ? -1 : 1);
            if (net >= Number(purchase.total_minor) && !firstFullAt) firstFullAt = entry.occurred_at;
        }
        const firstPaid = entries.find(entry => entry.kind !== 'refund')?.occurred_at || null;
        const depositAt = entries.find(entry => entry.kind === 'deposit')?.occurred_at || null;
        return { ...purchase, total_minor: Number(purchase.total_minor), paid_minor: net,
            outstanding_minor: net < 0 ? null : Math.max(0, Number(purchase.total_minor) - net), overpaid_minor: Math.max(0, net - Number(purchase.total_minor)),
            payment_status: net >= Number(purchase.total_minor) ? 'fully_paid' : net > 0 ? 'partially_paid' : firstPaid ? 'refunded_or_reversed' : 'no_verified_payment',
            first_payment_at: firstPaid, deposit_at: depositAt, first_full_payment_at: firstFullAt,
            inquiry_to_order_hours: hoursBetween(firstInquiryAt, purchase.purchased_at),
            inquiry_to_deposit_hours: hoursBetween(firstInquiryAt, depositAt),
            deposit_to_full_hours: hoursBetween(depositAt, firstFullAt), ever_paid: Boolean(firstPaid) };
    });
    const firstPayment = valid.find(payment => payment.kind !== 'refund')?.occurred_at || null;
    const firstDeposit = valid.find(payment => payment.kind === 'deposit')?.occurred_at || null;
    return { currencies: [...totals].map(([currency, amounts]) => ({ currency, ...amounts })), orders,
        purchase_count: orders.filter(order => order.ever_paid).length, recorded_order_count: orders.length,
        repeat_customer: orders.filter(order => order.ever_paid).length > 1,
        verified_payment_count: valid.filter(payment => payment.kind !== 'refund').length,
        unallocated_payment_count: valid.filter(payment => payment.kind !== 'refund' && !payment.purchase_id).length,
        first_payment_at: firstPayment, first_deposit_at: firstDeposit,
        inquiry_to_first_payment_hours: hoursBetween(firstInquiryAt, firstPayment),
        inquiry_to_first_deposit_hours: hoursBetween(firstInquiryAt, firstDeposit),
        status: !valid.length ? 'not_verified' : orders.length && orders.every(order => order.payment_status === 'fully_paid') ? 'recorded_orders_fully_paid' : 'verified_records_available' };
}

export function conversationEvidence(raw: ProfileMessage[], outbound: Array<{ message_id: string; source_type?: string; source_name?: string | null; sent_at?: string }> = []) {
    const messages = orderedMessages(raw);
    const first = messages.find(message => message.sender === 'customer' && !administrative(message.text)) || messages.find(message => message.sender === 'customer');
    const sources = new Map(outbound.map(event => [event.message_id, event]));
    const questions = new Map<string, { text: string; count: number; first_at: string; message_ids: string[] }>();
    const invoices = new Map<string, { reference: string; amount: number | null; at: string; message_id: string; status: 'requested_not_payment' }>();
    const seq = messages.map((message, i) => ({ id: message.id, i, ms: Date.parse(message.at), text: message.text,
        sender: message.sender === 'customer' ? 'contact' : message.sender, attachments: Array.from({ length: message.images || 0 }, () => ({ image_data: { url: 'attachment-present' } })) }));
    const payments: Array<{ kind: string; acknowledgment: boolean; amount: number | null; at: string; message_id: string; quote: string }> = [];
    const followUps: Array<{ at: string; message_id: string; source: string }> = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.sender === 'customer') {
            const parts: string[] = message.text.match(/[^?\n]+\?/g) || [];
            if (!parts.length && /^(?:magkano|paano|pano|saan|kailan|meron\s+ba|may\s+.+\s+ba|what|how|where|when|can\s+(?:i|you)|do\s+you)\b/i.test(message.text.trim()) && message.text.length < 600) parts.push(message.text.trim());
            for (const part of parts) {
                const text = part.trim();
                if (text.length < 4 || text.length > 1200) continue;
                const key = text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, '').replace(/\s+/g, ' ').trim();
                const previous = questions.get(key);
                if (previous) { previous.count++; if (!previous.message_ids.includes(message.id)) previous.message_ids.push(message.id); }
                else questions.set(key, { text, count: 1, first_at: message.at, message_ids: [message.id] });
            }
        }
        const signal = paymentSignal(seq[index], seq);
        if (signal) payments.push({ kind: signal.kind, acknowledgment: signal.confirmed === true, amount: signal.amount ?? null,
            at: message.at, message_id: message.id, quote: message.text.slice(0, 1000) });
        if (message.sender === 'page' && /^(?:You created an order for|You requested) /i.test(message.text)) {
            const reference = /invoice_id=(\d+)/.exec(message.text)?.[1];
            if (reference && !invoices.has(reference)) invoices.set(reference, { reference, amount: explicitAmount(message.text), at: message.at, message_id: message.id, status: 'requested_not_payment' });
        }
        const source = sources.get(message.id);
        if (message.sender === 'page' && source && /follow[ -]?up|reminder/i.test(source.source_name || '')) {
            followUps.push({ at: message.at, message_id: message.id, source: source.source_name || source.source_type || 'Tracked follow-up' });
        }
    }
    return { first_inquiry_at: first?.at || null, first_message_id: first?.id || null,
        last_message_at: messages.at(-1)?.at || null, message_count: messages.length,
        customer_message_count: messages.filter(message => message.sender === 'customer').length,
        page_message_count: messages.filter(message => message.sender === 'page').length,
        questions: [...questions.values()], unique_question_count: questions.size,
        payment_evidence: payments, invoice_requests: [...invoices.values()], tracked_follow_ups: followUps,
        first_payment_ack_at: payments.find(payment => payment.acknowledgment)?.at || null };
}

function normalized(text: string) { return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); }
const categories = new Set(['purpose', 'preference', 'business', 'requirement', 'purchase', 'problem', 'suggestion', 'objection', 'promise']);

/** AI facts must quote a real source message. Customer needs cannot come from a sales pitch. */
export function groundedAnalysis(value: unknown, messages: ProfileMessage[], requestedFields: string[] = []): { summary_points: SummaryPoint[]; facts: ProfileFact[]; answers: ExtractedAnswer[]; excluded: number } {
    const source = new Map(messages.map(message => [message.id, message]));
    const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    let excluded = 0;
    const evidence = (raw: unknown, customerOnly: boolean, allowNonTextReference = false): ProfileEvidence[] => (Array.isArray(raw) ? raw : []).slice(0, 8).flatMap(item => {
        if (!item || typeof item.message_id !== 'string' || typeof item.quote !== 'string') return [];
        const message = source.get(item.message_id);
        const quote = item.quote.trim();
        const nonTextReference = allowNonTextReference && (
            quote === '[image attachment]' && (message?.images ?? 0) > 0
            || quote === '[attachment]' && (message?.attachments ?? 0) > 0
            || quote === '[non-text message]' && !message?.text.trim()
        );
        if (!message || message.sender === 'unknown' || customerOnly && message.sender !== 'customer' || item.quote.trim().length < 1 || item.quote.length > 1000
            || !normalized(message.text).includes(normalized(item.quote)) && !nonTextReference) return [];
        return [{ message_id: message.id, quote: item.quote.trim() }];
    });
    const facts = (Array.isArray(input.facts) ? input.facts : []).slice(0, 150).flatMap(raw => {
        if (!raw || !categories.has(raw.category) || typeof raw.key !== 'string' || typeof raw.value !== 'string' || raw.key.length > 100 || raw.value.length > 1500) { excluded++; return []; }
        const proof = evidence(raw.evidence, !['purchase', 'promise'].includes(raw.category));
        if (!proof.length) { excluded++; return []; }
        return [{ category: raw.category, key: raw.key.trim(), value: raw.value.trim(), evidence: proof }];
    });
    const summary_points = (Array.isArray(input.summary_points) ? input.summary_points : []).slice(0, 12).flatMap(raw => {
        if (!raw || typeof raw.text !== 'string' || !raw.text.trim() || raw.text.length > 1200) { excluded++; return []; }
        const proof = evidence(raw.evidence, false, true);
        if (!proof.length) { excluded++; return []; }
        return [{ text: raw.text.trim(), evidence: proof }];
    });
    const answers = (Array.isArray(input.answers) ? input.answers : []).slice(0, 100).flatMap(raw => {
        if (!raw || !requestedFields.includes(raw.field) || typeof raw.value !== 'string' || !raw.value.trim() || raw.value.length > 2000) { excluded++; return []; }
        const proof = evidence(raw.evidence, true).filter(item => normalized(item.quote).includes(normalized(raw.value)));
        if (!proof.length) { excluded++; return []; }
        return [{ field: raw.field, value: raw.value.trim(), evidence: proof }];
    });
    return { summary_points, facts, answers, excluded };
}

export function mergeProfileFacts(chunks: Array<{ facts: ProfileFact[] }>) {
    const result = new Map<string, ProfileFact>();
    for (const chunk of chunks) for (const fact of chunk.facts) {
        const key = `${fact.category}|${normalized(fact.key)}|${normalized(fact.value)}`;
        const previous = result.get(key);
        if (previous) previous.evidence = [...new Map([...previous.evidence, ...fact.evidence].map(proof => [proof.message_id, proof])).values()];
        else result.set(key, { ...fact, evidence: [...fact.evidence] });
    }
    return [...result.values()];
}
