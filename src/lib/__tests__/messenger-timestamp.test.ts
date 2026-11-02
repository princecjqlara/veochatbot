import { describe, expect, it } from 'vitest';
import { messengerTimestamp } from '@/lib/messenger-timestamp';
describe('Messenger event timestamp units', () => {
 const now = Date.parse('2026-11-02T12:00:00Z'), ms = Date.parse('2026-11-02T03:44:48Z');
 it('maps seconds, milliseconds, numeric strings and ISO values to the same real event time', () => {
  for (const value of [ms / 1000, ms, String(ms / 1000), String(ms), '2026-11-02T03:44:48+0000', '2026-11-02T03:44:48Z']) expect(messengerTimestamp(value, now)).toBe(ms);
 });
 it('rejects missing, malformed, pre-calendar and future times instead of producing 1970 or future lead dates', () => {
  for (const value of [null, undefined, true, {}, '', 'abc', 0, -1, Infinity, '1970-01-01T00:00:00Z', now + 120000]) expect(messengerTimestamp(value, now)).toBeNull();
 });
});
