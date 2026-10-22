import { describe, expect, it } from 'vitest';
import { getBestTimeFollowUpDueAt, getPricingPromotionDays, normalizeBestTimeFollowUpDays } from '@/lib/chatbot-follow-up-timing';

describe('shared later-day follow-up formula', () => {
    it.each([
        ['2026-10-22T15:00:00Z', 2, 9, '2026-10-23T01:00:00.000Z'],
        ['2026-10-22T15:00:00Z', 3, 9, '2026-10-24T01:00:00.000Z'],
        ['2026-10-22T15:00:00Z', 5, null, '2026-10-26T04:00:00.000Z'],
        ['2026-12-31T15:00:00Z', 2, -1, '2027-01-01T04:00:00.000Z']
    ])('uses Manila calendar days and the best hour for %s, day %s', (anchor, day, hour, expected) => {
        expect(getBestTimeFollowUpDueAt(new Date(anchor), day, hour)).toBe(expected);
    });
    it('keeps selected days and applies pricing defaults without enabling ordinary reminders', () => {
        expect(getPricingPromotionDays([7, 3, 3, 1])).toEqual([3, 7]);
        expect(getPricingPromotionDays([])).toEqual([2, 3, 5, 7]);
        expect(normalizeBestTimeFollowUpDays([])).toEqual([]);
    });
});
