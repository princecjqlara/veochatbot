import { describe, expect, it } from 'vitest';
import { isSupabaseUnavailable } from '../supabase-errors';

describe('Supabase availability errors', () => {
    it.each([
        { message: 'Error: Supabase request timed out', code: '' },
        { code: 'SUPABASE_UPSTREAM_522' },
        { code: 'DATABASE_UNAVAILABLE' },
        { code: 'PGRST002' },
        new Error('Workspace page scope unavailable', { cause: { code: 'SUPABASE_UPSTREAM_522' } })
    ])('recognizes a transport or database outage: %j', error => {
        expect(isSupabaseUnavailable(error)).toBe(true);
    });
    it.each([{ code: '23505' }, { code: '42501' }, new Error('Workspace page scope unavailable'), null])('keeps validation and authorization failures distinct: %j', error => {
        expect(isSupabaseUnavailable(error)).toBe(false);
    });
});
