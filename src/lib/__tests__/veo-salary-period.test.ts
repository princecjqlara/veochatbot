import { expect, it } from 'vitest';
import { salaryMoney, salaryPeriod } from '../veo-salary-period';
const day = (date: string, currency: string, commission: string) => ({ user_id: 'worker', name: 'Worker', active: true, work_date: date, provisional: date === '2026-11-10', totals: [{ currency, gross_minor: '10000', commission_minor: commission }] });
it('adds authoritative daily amounts exactly while keeping currencies and employees separate', () => {
    const result = salaryPeriod([day('2026-11-08', 'PHP', '3500'), day('2026-11-09', 'PHP', '4000'), day('2026-11-10', 'USD', '1000')]);
    expect(result.totals.map(t => [t.currency, t.commission_minor])).toEqual([['PHP', 7500n], ['USD', 1000n]]); expect(result.people[0].provisional).toBe(true); expect(result.people[0].days.size).toBe(3);
    expect(salaryMoney(7500n, 'PHP')).toBe('PHP 75.00'); expect(salaryMoney(-1n, 'USD')).toBe('USD -0.01'); expect(salaryMoney(900719925474099199n, 'PHP')).toBe('PHP 9,007,199,254,740,991.99');
});
it('rejects duplicated or incomplete salary days and unsafe amounts rather than displaying partial totals', () => {
    const row = day('2026-11-09', 'PHP', '3500'); expect(() => salaryPeriod([row, row])).toThrow('Complete salary days');
    expect(() => salaryPeriod([{ ...row, totals: undefined }])).toThrow(); expect(() => salaryPeriod([day('2026-11-09', 'PHP', '3.5')])).toThrow();
    expect(() => salaryPeriod([{ ...row, totals: [{ currency: 'PHP', commission_minor: Number.MAX_SAFE_INTEGER + 1, gross_minor: 1 }] }])).toThrow();
});
it('keeps zero-value staff and former staff visible without inventing a currency or salary', () => {
    const result = salaryPeriod([{ user_id: 'former', name: 'Former worker', active: false, work_date: '2026-11-09', totals: [] }]); expect(result.totals).toEqual([]); expect(result.people[0].active).toBe(false); expect(result.people[0].amounts.size).toBe(0);
});
