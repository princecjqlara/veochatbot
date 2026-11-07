const minor = (v: unknown) => /^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
/** Shared campaign/ad-set budgets are allocated across their active ads once.
 * This allocation is a planning estimate, never a promise of Meta delivery. */
export function pageAdPlanning(ads: any[], pageIds: string[], currency: string, checkedAt: string) {
    const active = ads.filter(a => a.effective_status === 'ACTIVE'), groups = new Map<string, any[]>();
    for (const ad of active) {
        const campaign = ad.campaign || {}, adset = ad.adset || {};
        const scope = minor(campaign.daily_budget) != null || Number(campaign.lifetime_budget) > 0 ? 'campaign:' + campaign.id : 'adset:' + adset.id;
        groups.set(scope, [...groups.get(scope) || [], ad]);
    }
    return pageIds.map(page => {
        const own = active.filter(a => a.verified_page_id === page);
        let budget = 0, unknown = false, lifetime = false;
        for (const [key, rows] of groups) {
            const count = rows.filter(a => a.verified_page_id === page).length; if (!count) continue;
            const holder = key.startsWith('campaign:') ? rows[0].campaign : rows[0].adset;
            const daily = minor(holder?.daily_budget);
            if (daily == null) { unknown = true; lifetime ||= Number(holder?.lifetime_budget) > 0; }
            else budget += daily * count / rows.length;
        }
        return { page_id: page, currency, active_ads: own.length, allocated_daily_budget_minor: unknown ? null : Math.floor(budget),
            budget_mode: unknown ? lifetime ? 'lifetime_or_mixed' : 'unavailable' : 'daily', checked_at: checkedAt,
            basis: 'Current effective ACTIVE inventory; shared campaign/ad-set daily budgets allocated by active-ad count. Lifetime budgets are not daily budgets.' };
    });
}
