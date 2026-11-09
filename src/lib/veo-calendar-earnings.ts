const total = (rows: any[], field: string) => rows.reduce((n, r) => n + Number(r[field] || 0), 0);
export function createdOrderTotals(rows: any[]) {
    const unique = [...new Map(rows.map(r => [r.order_key, r])).values()];
    return { count: unique.length, finance: [...new Set<string>(unique.map(r => r.currency))].sort().map(currency => {
        const orders = unique.filter(r => r.currency === currency), known = orders.filter(r => r.balance_minor != null);
        return { currency, orders: orders.length, value_minor: total(orders, 'total_minor'),
            recorded_balance_minor: total(known, 'balance_minor'), balance_known_orders: known.length,
            balance_unknown_orders: orders.length - known.length };
    }) };
}

/** One denominator for the entire period. Unknown days never become free costs. */
export function calendarEarnings(days: any[], launchDay: string, today: string) {
    const eligible = days.filter(d => d.work_date >= launchDay && d.work_date <= today);
    const currencies = [...new Set<string>(eligible.flatMap(d => d.finance.map((r: any) => r.currency)))].sort();
    const fields = ['gross_before_refunds_minor', 'refunds_minor', 'gross_minor', 'salary_minor', 'ad_spend_minor', 'net_minor', 'received_minor'] as const;
    const finance = currencies.map(currency => {
        const rows = eligible.map(d => d.finance.find((r: any) => r.currency === currency));
        const values = Object.fromEntries(fields.map(field => [field,
            rows.every(r => r && r[field] != null) ? total(rows, field) : null])) as Record<typeof fields[number], number | null>;
        const completeCostDays = rows.filter(r => r?.net_minor != null).length;
        return { currency, ...values, average_gross_minor: values.gross_before_refunds_minor == null ? null : values.gross_before_refunds_minor / eligible.length,
            average_net_minor: values.net_minor == null ? null : values.net_minor / eligible.length,
            cost_complete_days: completeCostDays, cost_missing_days: eligible.length - completeCostDays };
    });
    return { from: eligible[0]?.work_date || null, to: eligible.at(-1)?.work_date || null, days: eligible.length,
        provisional: eligible.some(d => d.work_date === today), includes_zero_sale_days: true,
        closed: total(eligible, 'closed'), done: total(eligible, 'done'),
        orders_created: total(eligible.map(d => d.created_orders), 'count'), finance };
}
