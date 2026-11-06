import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { calculateVeoBudget } from '../veo-budget';
const inputs = { day: 4, startingBudget: 2000, currentBudget: 2800, yesterdayCPA: 400, yesterdayResult: 'PROFIT' };
describe('canonical VEO budget calculation with conserved roster capacity', () => {
    it.each(['aggressive', 'conservative'])('matches the original %s planner growth calculation and uses the shared quota', profile => {
        const sandbox: any = { document: { documentElement: { dataset: { plannerProfile: profile } } } };
        vm.runInNewContext(fs.readFileSync('../../veo ad budget/budget-model.js', 'utf8'), sandbox);
        const plan = { active_workers: 5, quota: 10, full_capacity: 12 };
        const actual = calculateVeoBudget({ ...inputs, profile, activePeople: 999, maxPerPerson: 999 }, plan);
        const original = sandbox.BudgetModel.calculate({ ...sandbox.BudgetModel.defaults, ...inputs, activePeople: 5, maxPerPerson: 2 / (1 - actual.inputs.reservePct / 100) });
        for (const key of ['budget', 'baseStep', 'candidate', 'acquisitions', 'maximumDailyBudget']) expect(actual.result[key]).toBeCloseTo(original[key], 8);
        expect(actual.inputs.activePeople).toBe(5);
        expect(actual.result).toMatchObject({ quota: 10, quota_closed: 10, quota_done: 10, capacity: 12, active_capacity: 10, teamQuota: 10, ad_supported_deals: original.teamQuota });
        expect(actual.result.budget).toBeLessThanOrEqual(10 * inputs.yesterdayCPA);
    });
    it('keeps the default target of one usable without applying another reserve reduction', () => {
        const actual = calculateVeoBudget(inputs, { active_workers: 1, quota: 1, full_capacity: 1 });
        expect(actual.result.maximumTeamProjects).toBe(1);
        expect(actual.result.budget).toBe(400);
        expect(actual.result.quota).toBe(1);
    });
    it('returns zero spend and zero quota when nobody is active', () => {
        expect(calculateVeoBudget(inputs, { active_workers: 0, quota: 0, full_capacity: 3 }).result).toMatchObject({ budget: 0, quota: 0, capacity: 3 });
    });
    it('rejects invalid strategy, non-finite money and an invalid reserve', () => {
        const plan = { active_workers: 1, quota: 1, full_capacity: 1 };
        expect(() => calculateVeoBudget({ ...inputs, profile: 'unsafe' }, plan)).toThrow();
        expect(() => calculateVeoBudget({ ...inputs, yesterdayCPA: Infinity }, plan)).toThrow();
        expect(() => calculateVeoBudget({ ...inputs, reservePct: 100 }, plan)).toThrow();
    });
});
