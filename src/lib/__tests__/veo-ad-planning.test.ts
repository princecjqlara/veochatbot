import { expect, it } from 'vitest';
import { pageAdPlanning } from '../veo-ad-planning';
it('conserves shared campaign daily budgets across Pages and non-VEO placements', () => {
    const ads = ['a', 'b', null, 'a'].map((verified_page_id, i) => ({ id: i, effective_status: 'ACTIVE', verified_page_id, campaign: { id: 'campaign', daily_budget: '10000' } }));
    const plans = pageAdPlanning(ads, ['a', 'b', 'quiet'], 'PHP', '2026-11-07');
    expect(plans.map(p => p.allocated_daily_budget_minor)).toEqual([5000, 2500, 0]); expect(plans[0].active_ads).toBe(2);
});
it('never treats lifetime or unavailable budget as zero funded ads and ignores paused ads', () => {
    const ads = [{ effective_status: 'ACTIVE', verified_page_id: 'a', adset: { id: 'set', lifetime_budget: '100000' } }, { effective_status: 'PAUSED', verified_page_id: 'b', adset: { id: 'paused', daily_budget: '2000' } }];
    expect(pageAdPlanning(ads, ['a', 'b'], 'PHP', '2026-11-07')).toMatchObject([{ active_ads: 1, allocated_daily_budget_minor: null, budget_mode: 'lifetime_or_mixed' }, { active_ads: 0, allocated_daily_budget_minor: 0 }]);
});
