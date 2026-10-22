import { describe, expect, it } from 'vitest';
import { buildFirstDaySchedule, FIRST_DAY_TIMING, firstDayDeadline, getFirstDayCandidate } from '@/lib/chatbot-first-day-timing';

const at = (local: string) => Date.parse(local + '+08:00');
const plan = (local: string) => {
    const time = at(local);
    return buildFirstDaySchedule({ firstInquiry: time, initialReplyEnd: time, lastOutbound: time, now: time });
};

describe('first-day timing opportunities', () => {
    it.each([
        ['2026-10-22T09:00:00', ['2026-10-22T09:45:00', '2026-10-22T12:45:00', '2026-10-22T17:15:00', '2026-10-23T08:00:00']],
        ['2026-10-22T08:00:00', ['2026-10-22T08:45:00', '2026-10-22T11:45:00', '2026-10-22T16:15:00']],
        ['2026-10-22T14:00:00', ['2026-10-22T14:45:00', '2026-10-22T17:45:00', '2026-10-23T08:00:00']],
        ['2026-10-22T22:00:00', ['2026-10-23T08:00:00', '2026-10-23T11:00:00', '2026-10-23T15:30:00']]
    ])('fits the complete elapsed first day for inquiry %s', (inquiry, expected) => {
        expect(plan(inquiry).map(item => Date.parse(item.dueAt))).toEqual(expected.map(at));
    });

    it('waits thirty minutes after a late initial reply', () => {
        const firstInquiry = at('2026-10-22T09:00:00');
        const reply = at('2026-10-22T10:00:00');
        const result = buildFirstDaySchedule({ firstInquiry, initialReplyEnd: reply, lastOutbound: reply, now: reply });
        expect(Date.parse(result[0].dueAt)).toBe(at('2026-10-22T10:30:00'));
    });

    it('uses actual earlier deliveries without restarting or sending missed slots together', () => {
        const firstInquiry = at('2026-10-22T09:00:00');
        const now = at('2026-10-22T13:00:00');
        const result = buildFirstDaySchedule({ firstInquiry, initialReplyEnd: firstInquiry,
            lastOutbound: now, now, sentTimes: [now] });
        expect(result[0]).toEqual({ sequenceIndex: 1, dueAt: new Date(at('2026-10-22T16:00:00')).toISOString() });
    });

    it('ends at the original inquiry deadline even when the reply arrives a day later', () => {
        const firstInquiry = at('2026-10-22T09:00:00');
        const now = at('2026-10-23T09:00:00');
        expect(buildFirstDaySchedule({ firstInquiry, initialReplyEnd: now, lastOutbound: now, now })).toEqual([]);
    });

    it('excludes a slot exactly at the ten-minute deadline buffer', () => {
        const firstInquiry = at('2026-10-22T14:00:00');
        const now = firstDayDeadline(firstInquiry);
        expect(getFirstDayCandidate({ firstInquiry, initialReplyEnd: firstInquiry, lastOutbound: firstInquiry,
            now, sequenceIndex: 0 })).toBeNull();
    });

    it('has no independent message-count limit', () => {
        const firstInquiry = at('2026-10-22T09:00:00');
        const result = buildFirstDaySchedule({ firstInquiry, initialReplyEnd: firstInquiry, lastOutbound: firstInquiry,
            now: firstInquiry, settings: { ...FIRST_DAY_TIMING, wakingStartHour: 0, wakingEndHour: 24,
                minimumGapMinutes: 60, baseGapMinutes: 60, growthFactor: 1, maximumGapMinutes: 60 } });
        expect(result.length).toBeGreaterThan(10);
        expect(result.every(item => Date.parse(item.dueAt) < firstDayDeadline(firstInquiry))).toBe(true);
    });

    it('rejects inconsistent timestamps and a zero-gap configuration', () => {
        const time = at('2026-10-22T09:00:00');
        expect(buildFirstDaySchedule({ firstInquiry: time, initialReplyEnd: time, lastOutbound: time,
            now: time, settings: { ...FIRST_DAY_TIMING, minimumGapMinutes: 0 } })).toEqual([]);
        expect(buildFirstDaySchedule({ firstInquiry: time, initialReplyEnd: time, lastOutbound: time,
            now: time, sentTimes: [time + 1] })).toEqual([]);
    });
});
