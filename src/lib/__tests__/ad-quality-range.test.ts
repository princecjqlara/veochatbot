import { describe, expect, it } from 'vitest';
import { adQualityRange } from '../ad-quality-range';
const now = new Date('2026-10-26T17:00:00Z'); // Oct 27, 01:00 PHT
describe('ad lead inquiry ranges', () => {
    it('uses Philippine midnight across the UTC date boundary', () => {
        expect(adQualityRange(new URLSearchParams('range=today'), now).from).toBe('2026-10-26T16:00:00.000Z');
        expect(adQualityRange(new URLSearchParams('range=7'), now).from).toBe('2026-10-20T16:00:00.000Z');
        expect(adQualityRange(new URLSearchParams('range=30'), now).from).toBe('2026-09-27T16:00:00.000Z');
    });
    it('includes the final custom calendar date and never projects future leads', () => {
        const r = adQualityRange(new URLSearchParams('range=custom&from=2026-10-20&to=2026-10-21'), now);
        expect(r.from).toBe('2026-10-19T16:00:00.000Z'); expect(r.to).toBe('2026-10-21T16:00:00.000Z');
        expect(adQualityRange(new URLSearchParams('range=custom&from=2026-10-20&to=2026-10-30'), now).to).toBe(now.toISOString());
    });
    it('keeps all-time unbounded at the start but rejects invalid and inverted dates', () => {
        expect(adQualityRange(new URLSearchParams('range=all'), now).from).toBeNull();
        for (const q of ['range=custom&from=2026-02-30&to=2026-03-01', 'range=custom&from=2026-10-21&to=2026-10-20', 'range=custom&from=2026-11-01&to=2026-11-02', 'range=90']) expect(() => adQualityRange(new URLSearchParams(q), now)).toThrow();
    });
});
