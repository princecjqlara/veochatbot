import { describe, expect, it } from 'vitest';
import {
    getNextPhilippinesScheduledAtIso,
    getPhilippinesDatePartsFromDateString,
    getPhilippinesHour,
    getPhilippinesScheduledAtIso,
    getTomorrowPhilippinesDateParts
} from '../philippines-time';

describe('philippines-time', () => {
    it('converts UTC timestamps into Philippine local hours', () => {
        expect(getPhilippinesHour(new Date('2026-07-29T01:00:00.000Z'))).toBe(9);
        expect(getPhilippinesHour(new Date('2026-07-29T18:00:00.000Z'))).toBe(2);
    });

    it('builds UTC schedule timestamps from Philippine local date and hour', () => {
        expect(
            getPhilippinesScheduledAtIso(9, {
                year: 2026,
                month: 6,
                day: 30
            })
        ).toBe('2026-07-30T01:00:00.000Z');
    });

    it('uses the next Philippine calendar day for next-day scheduling', () => {
        const dateParts = getTomorrowPhilippinesDateParts(new Date('2026-07-29T18:30:00.000Z'));

        expect(dateParts).toEqual({
            year: 2026,
            month: 6,
            day: 31
        });
    });

    it('finds the next occurrence of a Philippine local hour', () => {
        expect(getNextPhilippinesScheduledAtIso(9, new Date('2026-07-29T00:30:00.000Z')))
            .toBe('2026-07-29T01:00:00.000Z');
        expect(getNextPhilippinesScheduledAtIso(9, new Date('2026-07-29T01:30:00.000Z')))
            .toBe('2026-07-30T01:00:00.000Z');
    });

    it('schedules the nightly review at 23:59 Philippine time without moving it earlier', () => {
        expect(getPhilippinesScheduledAtIso(23, { year: 2026, month: 9, day: 17 }, 59))
            .toBe('2026-10-17T15:59:00.000Z');
        expect(getNextPhilippinesScheduledAtIso(23, new Date('2026-10-17T15:58:59.000Z'), 59))
            .toBe('2026-10-17T15:59:00.000Z');
    });

    it.each(['2026-10-17T15:59:00.000Z', '2026-10-17T15:59:59.000Z'])(
        'schedules a takeover at or after the cutoff on the next PH day: %s', (timestamp) => {
            expect(getNextPhilippinesScheduledAtIso(23, new Date(timestamp), 59))
                .toBe('2026-10-18T15:59:00.000Z');
        }
    );

    it.each([
        ['2026-10-31T15:59:00.000Z', '2026-11-01T15:59:00.000Z'],
        ['2026-12-31T15:59:00.000Z', '2027-01-01T15:59:00.000Z'],
        ['2028-02-28T15:59:00.000Z', '2028-02-29T15:59:00.000Z']
    ])('keeps minute precision across calendar rollovers: %s', (timestamp, expected) => {
        expect(getNextPhilippinesScheduledAtIso(23, new Date(timestamp), 59)).toBe(expected);
    });

    it('parses date-input strings as Philippine calendar dates', () => {
        expect(getPhilippinesDatePartsFromDateString('2026-07-30')).toEqual({
            year: 2026,
            month: 6,
            day: 30
        });
    });
});
