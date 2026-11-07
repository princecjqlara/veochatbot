import { describe, expect, it } from 'vitest';
import { conversationEvidence, groundedAnalysis, hoursBetween, mergeProfileFacts, parseMoneyMinor, purchaseMetrics, type ProfileMessage } from '@/lib/contact-profile-evidence';

const message = (id: string, hour: number, sender: ProfileMessage['sender'], text: string, images = 0): ProfileMessage => ({ id, at: new Date(Date.UTC(2026, 9, 1, hour)).toISOString(), sender, text, attachments: images, images });
const order = { id: 'order', description: 'Commercial video', total_minor: 70000, currency: 'PHP', purchased_at: '2026-10-01T03:00:00Z' };
const deposit = { id: 'dp', purchase_id: 'order', kind: 'deposit' as const, amount_minor: 15000, currency: 'PHP', occurred_at: '2026-10-01T04:00:00Z', reference: 'GCASH-DP' };
const balance = { id: 'balance', purchase_id: 'order', kind: 'balance' as const, amount_minor: 55000, currency: 'PHP', occurred_at: '2026-10-03T04:00:00Z', reference: 'GCASH-BALANCE' };

describe('verified purchase and payment arithmetic', () => {
    it('shows the approved PHP two-peso settlement consistently in contact history', () => {
        const metrics = purchaseMetrics([{ ...order, settlement_tolerance_minor: 200 }], [deposit, { ...balance, amount_minor: 54800 }], '2026-10-01T00:00:00Z');
        expect(metrics.orders[0].payment_status).toBe('fully_paid'); expect(metrics.orders[0].outstanding_minor).toBe(0); expect(metrics.orders[0].closed_to_done_hours).toBe(48);
        expect(purchaseMetrics([{ ...order, settlement_tolerance_minor: 200 }], [deposit, { ...balance, amount_minor: 54799 }], null).orders[0].payment_status).toBe('partially_paid');
    });
    it('uses integer minor units and rejects ambiguous or unsafe amounts', () => {
        expect(parseMoneyMinor('1,234.50')).toBe(123450);
        expect(parseMoneyMinor('0.01')).toBe(1);
        for (const input of ['0', '-1', '12,34', '1.001', '1e3', 'NaN', 'Infinity', '10.0.0', '', '100000000000000']) expect(() => parseMoneyMinor(input)).toThrow();
    });
    it('distinguishes an order from payment and never assumes that missing records mean unpaid', () => {
        const metrics = purchaseMetrics([order], [], '2026-10-01T00:00:00Z');
        expect(metrics.status).toBe('not_verified'); expect(metrics.purchase_count).toBe(0);
        expect(metrics.orders[0].payment_status).toBe('no_verified_payment'); expect(metrics.first_payment_at).toBeNull();
    });
    it('calculates partial payments, remaining balance and exact deposit-to-full timing', () => {
        const partial = purchaseMetrics([order], [deposit], '2026-10-01T00:00:00Z');
        expect(partial.orders[0]).toMatchObject({ paid_minor: 15000, outstanding_minor: 55000, payment_status: 'partially_paid', inquiry_to_deposit_hours: 4, first_full_payment_at: null });
        const full = purchaseMetrics([order], [balance, deposit], '2026-10-01T00:00:00Z');
        expect(full.orders[0]).toMatchObject({ paid_minor: 70000, outstanding_minor: 0, payment_status: 'fully_paid', deposit_to_full_hours: 48 });
        expect(full.currencies).toEqual([{ currency: 'PHP', received_minor: 70000, refunded_minor: 0, net_minor: 70000, paid_order_count: 1, average_order_minor: 70000, average_paid_minor: 70000 }]);
    });
    it('does not add full-payment labels or currencies together and preserves refund history', () => {
        const smallFull = { ...deposit, kind: 'full' as const };
        expect(purchaseMetrics([order], [smallFull], null).orders[0].payment_status).toBe('partially_paid');
        const refunded = purchaseMetrics([order], [deposit, balance, { ...balance, id: 'refund', kind: 'refund', amount_minor: 70000, occurred_at: '2026-10-04T00:00:00Z' }], null);
        expect(refunded.purchase_count).toBe(1); expect(refunded.orders[0].payment_status).toBe('refunded_or_reversed');
        const mixed = purchaseMetrics([order], [deposit, { ...deposit, id: 'usd', purchase_id: null, currency: 'USD', amount_minor: 500 }], null);
        expect(mixed.currencies).toHaveLength(2); expect(mixed.orders[0].paid_minor).toBe(15000); expect(mixed.unallocated_payment_count).toBe(1);
    });
    it('excludes voided records, counts repeat paid orders and never invents negative elapsed time', () => {
        expect(purchaseMetrics([order], [{ ...deposit, voided_at: '2026-10-02T00:00:00Z' }], null).verified_payment_count).toBe(0);
        expect(purchaseMetrics([order, { ...order, id: 'second' }], [deposit, { ...balance, purchase_id: 'second' }], null).repeat_customer).toBe(true);
        expect(hoursBetween('2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z')).toBeNull();
    });
});
it('calculates average paid-order value once per verified order, separates currencies and includes refunds', () => {
    const orders = [order, { ...order, id: 'second' }, { ...order, id: 'unpaid' }];
    const records = [deposit, balance, { ...deposit, id: 'second-paid', purchase_id: 'second', amount_minor: 10000 }, { ...balance, id: 'refund', kind: 'refund' as const, amount_minor: 20000 }, { ...deposit, id: 'usd', purchase_id: null, currency: 'USD', amount_minor: 500 }];
    const r = purchaseMetrics(orders, records, null);
    expect(r.currencies.find(c => c.currency === 'PHP')).toMatchObject({ paid_order_count: 2, average_order_minor: 70000, average_paid_minor: 30000, net_minor: 60000 });
    expect(r.currencies.find(c => c.currency === 'USD')).toMatchObject({ paid_order_count: 0, average_order_minor: null, net_minor: 500 });
});

describe('conversation evidence without invented payment status', () => {
    it('groups repeated customer question phrases and ignores Page questions', () => {
        const result = conversationEvidence([message('1', 0, 'customer', 'How much?'), message('2', 1, 'customer', 'HOW MUCH?'), message('3', 2, 'page', 'What is your budget?'), message('4', 3, 'customer', 'Kailan po matatapos?')]);
        expect(result.unique_question_count).toBe(2); expect(result.questions[0].count).toBe(2); expect(result.first_message_id).toBe('1');
    });
    it('separates customer claims, Page acknowledgments and invoice requests', () => {
        const result = conversationEvidence([message('1', 0, 'customer', 'I need a video'), message('2', 1, 'customer', 'Payment sent na po PHP150'),
            message('3', 2, 'page', 'You requested PHP700. View: fb-pma://payments/orderdetails/?invoice_id=123'), message('4', 3, 'page', 'Payment received PHP150, thank you!')]);
        expect(result.payment_evidence.find(item => item.message_id === '2')?.acknowledgment).toBe(false);
        expect(result.payment_evidence.find(item => item.message_id === '4')?.acknowledgment).toBe(true);
        expect(result.invoice_requests[0]).toMatchObject({ reference: '123', status: 'requested_not_payment' });
        expect(result.first_payment_ack_at).toBe(message('4', 3, 'page', '').at);
    });
    it('uses nearby customer context to classify a Page payment acknowledgment without upgrading it to verified', () => {
        const result = conversationEvidence([message('1', 0, 'customer', 'Payment sent na po DP PHP150', 1), message('2', 1, 'page', 'Received')]);
        const acknowledgment = result.payment_evidence.find(item => item.message_id === '2');
        expect(acknowledgment).toMatchObject({ acknowledgment: true, payment_type: 'downpayment', amount_basis: 'No amount stated in acknowledgement', related_message_ids: ['1'] });
    });
    it('does not treat future promises, quotations or a non-image attachment as a receipt', () => {
        const result = conversationEvidence([message('1', 0, 'customer', 'I will send payment tomorrow PHP150'),
            { ...message('2', 1, 'customer', 'Payment sent na po'), attachments: 1, images: 0 }, message('3', 2, 'page', 'Received po')]);
        expect(result.first_payment_ack_at).toBeNull();
    });
    it('counts only follow-ups with exact recorded attribution', () => {
        const result = conversationEvidence([message('1', 0, 'customer', 'Hello'), message('2', 1, 'page', 'Checking in'), message('3', 2, 'page', 'Checking in again')],
            [{ message_id: '2', source_name: 'Chatbot follow-up', source_type: 'automation' }, { message_id: '3', source_name: 'Manual reply', source_type: 'manual' }]);
        expect(result.tracked_follow_ups.map(item => item.message_id)).toEqual(['2']);
    });
});

describe('grounded AI profile facts', () => {
    it('extracts only requested fields with exact customer answers and keeps changed answers', () => {
        const messages = [message('1', 0, 'customer', 'For Facebook ads, portrait please.'), message('2', 1, 'customer', 'Change to landscape please.'), message('3', 2, 'page', 'We recommend a monthly package.')];
        const result = groundedAnalysis({ answers: [
            { field: 'Purpose', value: 'Facebook ads', evidence: [{ message_id: '1', quote: 'For Facebook ads' }] },
            { field: 'Format', value: 'portrait', evidence: [{ message_id: '1', quote: 'portrait please.' }] },
            { field: 'Format', value: 'landscape', evidence: [{ message_id: '2', quote: 'landscape please.' }] },
            { field: 'Purpose', value: 'Monthly package', evidence: [{ message_id: '3', quote: 'monthly package.' }] },
            { field: 'Not requested', value: 'Facebook ads', evidence: [{ message_id: '1', quote: 'For Facebook ads' }] },
            { field: 'Purpose', value: 'Increase sales', evidence: [{ message_id: '1', quote: 'For Facebook ads' }] }
        ] }, messages, ['Purpose', 'Format']);
        expect(result.answers.map(answer => answer.value)).toEqual(['Facebook ads', 'portrait', 'landscape']);
        expect(result.excluded).toBe(3);
    });
    it('rejects invented evidence and Page sales pitches attributed to the customer', () => {
        const messages = [message('customer', 0, 'customer', 'Gusto ko po pang Facebook ads, portrait.'), message('page', 1, 'page', 'Our offer helps businesses increase sales')];
        const result = groundedAnalysis({ summary_points: [{ text: 'Customer wants Facebook ads', evidence: [{ message_id: 'customer', quote: 'pang Facebook ads' }] }], facts: [
            { category: 'purpose', key: 'Goal', value: 'Increase sales', evidence: [{ message_id: 'page', quote: 'increase sales' }] },
            { category: 'preference', key: 'Orientation', value: 'Portrait', evidence: [{ message_id: 'customer', quote: 'portrait.' }] },
            { category: 'problem', key: 'Problem', value: 'Slow delivery', evidence: [{ message_id: 'made-up', quote: 'slow delivery' }] }
        ] }, messages);
        expect(result.summary_points).toHaveLength(1); expect(result.facts).toHaveLength(1); expect(result.facts[0].value).toBe('Portrait'); expect(result.excluded).toBe(2);
    });
    it('retains changed answers while deduplicating repeated supported facts', () => {
        const a = { category: 'preference', key: 'Format', value: 'Portrait', evidence: [{ message_id: '1', quote: 'portrait' }] };
        const merged = mergeProfileFacts([{ facts: [a] }, { facts: [{ ...a, evidence: [{ message_id: '2', quote: 'Portrait' }] }, { ...a, value: 'Landscape', evidence: [{ message_id: '3', quote: 'landscape' }] }] }]);
        expect(merged).toHaveLength(2); expect(merged[0].evidence).toHaveLength(2);
    });
});
