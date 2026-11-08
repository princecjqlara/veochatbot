import model from './veo-budget-model';
import { getSupabaseAdmin } from './supabase';
import { readVeoRpc } from './veo-report-read';

export function calculateVeoBudget(inputs: Record<string, any>, plan: any) {
    const profile = inputs.profile || 'aggressive';
    if (!['aggressive', 'conservative'].includes(profile)) throw new Error('Choose a VEO budget strategy');
    const clean: Record<string, any> = { ...model.defaults, ...model.profiles[profile], profile };
    for (const key of Object.keys(clean)) if (key in inputs && !['activePeople', 'maxPerPerson', 'profile'].includes(key)) clean[key] = key === 'yesterdayResult' ? inputs[key] : Number(inputs[key]);
    clean.activePeople = Number(plan.active_workers);
    // Worker targets already include the historical 80% buffer. Recover the
    // planner's pre-reserve ceiling so its reserve is applied once, and a
    // default target of one can still support one project.
    clean.maxPerPerson = (clean.activePeople ? Number(plan.quota) / clean.activePeople : 1) / (1 - clean.reservePct / 100);
    const result = model.calculate(clean);
    if (result.errors?.length) throw new Error(result.errors.join(' '));
    if (result.budget > Number(plan.quota) * clean.yesterdayCPA + .000001) throw new Error('Budget exceeds the authoritative Page capacity');
    return { inputs: clean, result: { ...result, quota: Number(plan.quota), individual_target_source: 'VEO frozen worker capacity',
        capacity: Number(plan.full_capacity), full_capacity: Number(plan.full_capacity), active_capacity: Number(plan.quota), teamQuota: Number(plan.quota), ad_model_capacity: result.capacity,
        ad_supported_deals: result.teamQuota, expected_ad_workload: result.acquisitions, quota_closed: Number(plan.quota), quota_done: Number(plan.quota),
        source: 'Canonical veo ad budget model with VEO roster and conserved Page allocations' } };
}

export async function pageBudgetData(actor: string, day: string) {
    const db = getSupabaseAdmin(), plan = await readVeoRpc(db, 'veo_page_capacity', { p_actor: actor, p_day: day });
    if (plan.error) throw Object.assign(new Error('Page capacity is temporarily unavailable. Retry shortly.'), { status: plan.error.code === '42501' ? 403 : 503 });
    const ids = [...new Set<string>((plan.data.plans || []).map((p: any) => p.team_id))];
    const saved = ids.length ? await db.from('veo_ad_budget_plans').select('*').in('team_id', ids).eq('work_date', day) : { data: [], error: null };
    if (saved.error) throw new Error('Saved Page budgets are unavailable');
    const records = (saved.data || []).map(row => {
        const current = (plan.data.plans || []).find((p: any) => p.team_id === row.team_id && p.page_id === row.page_id);
        if (plan.data.historical || !current) return row;
        try { return { ...row, result_current: calculateVeoBudget(row.inputs, current).result }; }
        catch { return { ...row, calculation_unavailable: true }; }
    });
    const pages = [...new Set<string>((plan.data.plans || []).map((p: any) => p.page_id))];
    const ads = pages.length ? await db.from('veo_ad_planning_state').select('*').in('page_id', pages) : { data: [], error: null };
    return { ...plan.data, live_ads: ads.error ? null : ads.data, saved: records, presets: model.profiles, defaults: { ...model.defaults, profile: 'aggressive', startingBudget: null, currentBudget: null, yesterdayCPA: null, activePeople: null, maxPerPerson: null } };
}

export async function savePageBudget(actor: string, body: any) {
    const db = getSupabaseAdmin();
    if (body.action === 'page_weight') {
        if (!Number.isInteger(Number(body.weight)) || Number(body.weight) < 0 || Number(body.weight) > 1000) throw new Error('Weight must be a whole number from 0 to 1000');
        const r = await db.rpc('veo_budget_action', { p_actor: actor, p_action: body.action, p_data: body });
        if (r.error) throw Object.assign(new Error(r.error.message), { status: r.error.code === '42501' ? 403 : 400 });
        return r.data;
    }
    if (!body.inputs || ['startingBudget', 'currentBudget', 'yesterdayCPA'].some(k => body.inputs[k] == null || body.inputs[k] === '')) throw new Error('Enter the starting budget, current budget and estimated CPA');
    const data = await pageBudgetData(actor, body.work_date), plan = data.plans.find((p: any) => p.team_id === body.team_id && p.page_id === body.page_id);
    if (!plan) throw Object.assign(new Error('Team or Page outside your scope'), { status: 403 });
    const calculated = calculateVeoBudget(body.inputs, plan), currency = String(body.currency || 'PHP').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Enter a three-letter currency');
    if (body.action === 'calculate') return { ...calculated, capacity_snapshot: plan, currency };
    const r = await db.rpc('veo_budget_action', { p_actor: actor, p_action: 'budget_save', p_data: { ...body, currency, ...calculated } });
    if (r.error) throw Object.assign(new Error(r.error.message), { status: r.error.code === '42501' ? 403 : 400 });
    return r.data;
}

export async function refreshPageBudgets() {
    const db = getSupabaseAdmin();
    const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), tomorrow = new Date(Date.now() + 32 * 3600000).toISOString().slice(0, 10);
    const due = await db.from('veo_ad_budget_plans').select('*').in('work_date', [day, tomorrow])
        .lt('checked_at', new Date(Date.now() - 300_000).toISOString()).order('checked_at').limit(30);
    if (due.error) throw new Error('Budget reconciliation unavailable');
    const owners = new Map<string, string>();
    const capacities = new Map<string, any>();
    for (const row of due.data || []) {
        let owner = owners.get(row.tenant_id);
        if (!owner) { const t = await db.from('veo_tenants').select('owner_id').eq('id', row.tenant_id).single(); if (t.error) throw new Error('Budget owner unavailable'); owner = t.data.owner_id; owners.set(row.tenant_id, owner!); }
        const key = `${row.tenant_id}:${row.work_date}`;
        if (!capacities.has(key)) {
            const result = await readVeoRpc(db, 'veo_page_capacity', { p_actor: owner, p_day: row.work_date });
            if (result.error) throw new Error('Budget capacity reconciliation unavailable');
            capacities.set(key, result.data);
        }
        const plan = capacities.get(key)?.plans?.find((p: any) => p.team_id === row.team_id && p.page_id === row.page_id);
        if (!plan) throw new Error('Team or Page outside the current budget scope');
        const calculated = calculateVeoBudget(row.inputs, plan);
        const saved = await db.rpc('veo_budget_action', { p_actor: owner, p_action: 'budget_save', p_data: {
            team_id: row.team_id, page_id: row.page_id, work_date: row.work_date, currency: row.currency, ...calculated,
            reason: 'Automatic reconciliation with current attendance and frozen worker capacity'
        } });
        if (saved.error) throw new Error('Budget reconciliation could not be saved');
    }
}
