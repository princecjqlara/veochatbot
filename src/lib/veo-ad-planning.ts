const minor = (v: unknown) => /^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
/** Shared campaign/ad-set budgets are allocated across their active ads once.
 * This allocation is a planning estimate, never a promise of Meta delivery. */
export function pageAdPlanning(ads: any[], pageIds: string[], currency: string, checkedAt: string) {
    const active = ads.filter(a => a.effective_status === 'ACTIVE'), groups = new Map<string, any[]>();
    for (const ad of active) {
        const campaign = ad.campaign || {}, adset = ad.adset || {};
        const campaignFunded = Number(campaign.daily_budget) > 0 || Number(campaign.lifetime_budget) > 0;
        const scope = campaignFunded && campaign.id ? 'campaign:' + campaign.id : adset.id ? 'adset:' + adset.id : 'unknown:' + ad.id;
        groups.set(scope, [...groups.get(scope) || [], ad]);
    }
    const shares = new Map<string, number>(), unknownPages = new Set<string>(), lifetimePages = new Set<string>();
    for (const [key, rows] of groups) {
        const holder = key.startsWith('campaign:') ? rows[0].campaign : key.startsWith('adset:') ? rows[0].adset : null;
        const daily = Number(holder?.lifetime_budget) > 0 ? null : minor(holder?.daily_budget), weights = new Map<string, number>();
        const consistent = rows.every(ad => {
            const value = key.startsWith('campaign:') ? ad.campaign : ad.adset;
            return minor(value?.daily_budget) === daily && String(value?.lifetime_budget || '0') === String(holder?.lifetime_budget || '0');
        });
        for (const ad of rows) { const page = ad.verified_page_id || '__other__'; weights.set(page, (weights.get(page) || 0) + 1); }
        if (daily == null || !consistent) { for (const page of weights.keys()) { unknownPages.add(page); if (Number(holder?.lifetime_budget) > 0) lifetimePages.add(page); } continue; }
        const allocations = [...weights].map(([page, count]) => { const raw = BigInt(daily) * BigInt(count), denominator = BigInt(rows.length); return { page, floor: Number(raw / denominator), remainder: raw % denominator }; })
            .sort((a, b) => Number(b.remainder - a.remainder) || a.page.localeCompare(b.page));
        const remainder = daily - allocations.reduce((total, row) => total + row.floor, 0);
        allocations.forEach((row, index) => shares.set(row.page, (shares.get(row.page) || 0) + row.floor + (index < remainder ? 1 : 0)));
    }
    return pageIds.map(page => {
        const own = active.filter(a => a.verified_page_id === page);
        const unknown = unknownPages.has(page), lifetime = lifetimePages.has(page), budget = shares.get(page) || 0;
        return { page_id: page, currency, active_ads: own.length, allocated_daily_budget_minor: unknown ? null : Math.floor(budget),
            budget_mode: unknown ? lifetime ? 'lifetime_or_mixed' : 'unavailable' : 'daily', checked_at: checkedAt,
            basis: 'Current effective ACTIVE inventory; shared campaign/ad-set daily budgets allocated by active-ad count. Lifetime budgets are not daily budgets.' };
    });
}
