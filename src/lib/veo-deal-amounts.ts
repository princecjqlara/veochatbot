import { parseMoneyMinor } from './money-minor';

const invalid = (message: string): never => { throw Object.assign(Error(message), { status: 422 }); };
function amount(value: unknown, label: string, allowZero = false, optional = false): number {
    const text = String(value ?? '').trim();
    if (optional && !text || allowZero && /^0(?:\.0{1,2})?$/.test(text)) return 0;
    try { return parseMoneyMinor(value); }
    catch { return invalid(`Enter ${label} as ${allowZero ? 'zero or a positive amount' : 'a positive amount'} with at most two decimal places`); }
}

export function assertDoneSettlement(total: number, received: number, earlier: number, currency: string) {
    if (earlier + received <= 0 || Math.abs(earlier + received - total) > (currency === 'PHP' ? 200 : 0)) {
        const remaining = (Math.max(0, total - earlier) / 100).toFixed(2);
        invalid(`Done Deal must settle the deal price. Enter ${currency} ${remaining} as the amount received now, excluding any tip. Enter the tip separately.`);
    }
}

/** Shared form/API validation. A direct Done Deal creates its own fully paid
 * order; it does not require an earlier Close Deal or a deposit. */
export function dealAmounts(body: any) {
    const total_price_minor = amount(body.total_price, 'the total deal price');
    const closed = body.receipt_kind === 'closed';
    const closed_amount_minor = closed ? amount(body.closed_amount, 'the Close Deal amount') : 0;
    const received_now_minor = closed ? 0 : amount(body.done_amount, 'the Done Deal amount received now', true);
    const tip_minor = closed ? 0 : amount(body.tip, 'the tip', true, true);
    if (closed_amount_minor > total_price_minor) invalid('The Close Deal amount cannot exceed the total deal price');
    if (!closed && !body.order_id && !body.closed_deal_id) {
        assertDoneSettlement(total_price_minor, received_now_minor, 0, String(body.currency || 'PHP').toUpperCase());
    }
    return { total_price_minor, closed_amount_minor, received_now_minor, tip_minor };
}
