import { expect, it } from 'vitest';
import { assertDoneSettlement, dealAmounts } from '../veo-deal-amounts';

const direct = { receipt_kind: 'done', total_price: '1000', done_amount: '1000', currency: 'PHP' };
it.each([undefined, null, '', '  ', '0', '0.00'])('accepts no optional tip (%s) on a direct Done Deal', tip => {
    expect(dealAmounts({ ...direct, tip })).toEqual({ total_price_minor: 100000, closed_amount_minor: 0, received_now_minor: 100000, tip_minor: 0 });
});
it('keeps a direct Done Deal tip out of the order price and full payment', () => {
    expect(dealAmounts({ ...direct, tip: '125.50' }).tip_minor).toBe(12550);
    expect(() => dealAmounts({ ...direct, done_amount: '1125.50', tip: '125.50' })).toThrow('PHP 1000.00');
});
it.each(['', '-1', 'NaN', '1.001'])('rejects invalid Done Deal payments before uploading or saving (%s)', done_amount => {
    expect(() => dealAmounts({ ...direct, done_amount })).toThrow('Done Deal amount received now');
});
it('requires a fully paid direct deal without inventing a missing Close Deal', () => {
    expect(() => dealAmounts({ ...direct, done_amount: '700' })).toThrow('PHP 1000.00');
    expect(() => dealAmounts({ ...direct, done_amount: '0' })).toThrow('settle the deal price');
    expect(dealAmounts({ ...direct, order_id: 'existing', done_amount: '700' }).received_now_minor).toBe(70000);
    expect(() => assertDoneSettlement(100000, 70000, 30000, 'PHP')).not.toThrow();
});
it('retains the existing PHP settlement tolerance and exact settlement for other currencies', () => {
    expect(() => dealAmounts({ ...direct, done_amount: '998' })).not.toThrow();
    expect(() => dealAmounts({ ...direct, done_amount: '997.99' })).toThrow('settle the deal price');
    expect(() => dealAmounts({ ...direct, currency: 'USD', done_amount: '999.99' })).toThrow('USD 1000.00');
});
it('keeps Close Deal separate and rejects a down payment greater than its price', () => {
    expect(dealAmounts({ ...direct, receipt_kind: 'closed', closed_amount: '300', done_amount: '', tip: '' })).toEqual({ total_price_minor: 100000, closed_amount_minor: 30000, received_now_minor: 0, tip_minor: 0 });
    expect(() => dealAmounts({ ...direct, receipt_kind: 'closed', closed_amount: '1001' })).toThrow('cannot exceed');
});
