import { getPhilippinesDateParts, getPhilippinesScheduledAtIso } from '@/lib/philippines-time';

export function normalizeBestTimeFollowUpDays(value: unknown): number[] {
    return Array.from(new Set((Array.isArray(value) ? value : []).map(item => Math.round(Number(item)))
        .filter(item => Number.isFinite(item) && item >= 2 && item <= 7))).sort((a, b) => a - b).slice(0, 6);
}

export function getPricingPromotionDays(value: unknown): number[] {
    const days = normalizeBestTimeFollowUpDays(value);
    return days.length ? days : [2, 3, 5, 7];
}

export function getBestTimeFollowUpDueAt(anchor: Date, dayNumber: number, bestHour: number | null | undefined): string {
    const base = getPhilippinesDateParts(anchor);
    const target = new Date(Date.UTC(base.year, base.month, base.day + Math.max(1, dayNumber - 1)));
    const hour = Number.isInteger(bestHour) && Number(bestHour) >= 0 && Number(bestHour) <= 23 ? Number(bestHour) : 12;
    return getPhilippinesScheduledAtIso(hour, {
        year: target.getUTCFullYear(), month: target.getUTCMonth(), day: target.getUTCDate()
    });
}
