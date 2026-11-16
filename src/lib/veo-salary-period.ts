type Amounts = { currency: string; gross_minor: bigint; commission_minor: bigint };
const minor = (value: unknown) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) || !['string', 'number'].includes(typeof value) || !/^-?\d+$/.test(String(value))) throw Error('Complete salary amounts are unavailable. Refresh to retry.');
    return BigInt(String(value));
};
export function salaryPeriod(days: any[]) {
    const totals = new Map<string, Amounts>(), people = new Map<string, { id: string; name: string; active: boolean; days: Set<string>; provisional: boolean; amounts: Map<string, Amounts> }>();
    const dates = new Map<string, { date: string; people: Set<string>; provisional: boolean; amounts: Map<string, Amounts> }>();
    const rows: Array<{ day: any; amounts: Amounts[] }> = [];
    const seen = new Set<string>();
    for (const day of days) {
        if (!day?.user_id || !day.work_date || !Array.isArray(day.totals) || seen.has(day.user_id + ':' + day.work_date)) throw Error('Complete salary days are unavailable. Refresh to retry.');
        seen.add(day.user_id + ':' + day.work_date);
        const person = people.get(day.user_id) || { id: day.user_id, name: day.name || 'Unknown employee', active: day.active !== false, days: new Set<string>(), provisional: false, amounts: new Map<string, Amounts>() };
        person.days.add(day.work_date); person.provisional ||= day.provisional === true;
        const date = dates.get(day.work_date) || { date: day.work_date, people: new Set<string>(), provisional: false, amounts: new Map<string, Amounts>() };
        date.people.add(day.user_id);date.provisional ||= day.provisional === true;
        const amounts: Amounts[] = [];
        const currencies = new Set<string>();
        for (const value of day.totals) {
            if (!/^[A-Z]{3}$/.test(value?.currency) || currencies.has(value.currency)) throw Error('Complete salary currencies are unavailable. Refresh to retry.');
            currencies.add(value.currency);
            const gross = minor(value.gross_minor), commission = minor(value.commission_minor);
            amounts.push({ currency: value.currency, gross_minor: gross, commission_minor: commission });
            for (const target of [totals, person.amounts, date.amounts]) {
                const amount = target.get(value.currency) || { currency: value.currency, gross_minor: 0n, commission_minor: 0n };
                amount.gross_minor += gross; amount.commission_minor += commission; target.set(value.currency, amount);
            }
        }
        people.set(day.user_id, person);
        dates.set(day.work_date, date);rows.push({ day, amounts });
    }
    return { totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)), people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)), dates: [...dates.values()].sort((a,b)=>b.date.localeCompare(a.date)), rows: rows.sort((a,b)=>b.day.work_date.localeCompare(a.day.work_date)||String(a.day.name||'').localeCompare(String(b.day.name||''))) };
}
export function salaryMoney(value: bigint, currency: string) {
    const abs = value < 0n ? -value : value;
    return `${currency} ${value < 0n ? '-' : ''}${new Intl.NumberFormat('en-PH', { maximumFractionDigits: 0 }).format(abs / 100n)}.${String(abs % 100n).padStart(2, '0')}`;
}
