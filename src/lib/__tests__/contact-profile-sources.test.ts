import { describe, expect, it } from 'vitest';
import { describeSourceTouch, getContactSources, sourceCreative } from '@/lib/contact-profile-sources';

const firstAt = '2026-10-01T00:00:00Z';
const source = { page_id: 'page', contact_id: 'contact', first_inquiry_at: firstAt, inquiry_basis: 'live_message', origin_ad_id: '100', origin_evidence_key: 'origin', attribution_status: 'verified_inline' };
const origin = { page_id: 'page', contact_id: 'contact', event_key: 'origin', event_at: firstAt, event_kind: 'message', ad_id: '100', message_id: 'message-1', referral: { source: 'ADS', type: 'OPEN_THREAD', ref: 'campaign-code', ads_context_data: { ad_title: 'Original offer', photo_url: 'https://example.com/original.jpg', post_id: '10_20' } } };
const later = { ...origin, event_key: 'later', event_at: '2026-10-03T00:00:00Z', ad_id: '200', referral: { source: 'ADS' } };
const ad = { page_id: 'page', ad_id: '100', ad_name: 'Campaign ad', campaign_name: 'October campaign', campaign_id: '300', adset_name: 'Local audience', adset_id: '400', creative_id: '500', photo_url: 'https://example.com/latest.jpg', video_url: 'https://example.com/latest.mp4', post_id: '10_30', post_permalink_url: 'https://facebook.com/latest' };

function database(overrides: Record<string, any[]> = {}) {
    const tables: Record<string, any[]> = { contacts: [{ id: 'contact', page_id: 'page' }], ad_contact_sources: [source],
        ad_referral_events: [origin, later], ad_source_catalog: [ad, { ...ad, ad_id: '200', ad_name: 'Return ad' }, { ...ad, page_id: 'foreign', ad_name: 'Other Page private ad' }], ...overrides };
    const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
    return { calls, from: (table: string) => {
        const filters: Record<string, any> = {}, membership: Record<string, any[]> = {}; let range: number[] | undefined;
        calls.push({ table, filters });
        const result = () => {
            const rows = (tables[table] || []).filter(row => Object.entries(filters).every(([key, value]) => row[key] === value)
                && Object.entries(membership).every(([key, values]) => values.includes(row[key])))
                .sort((a, b) => String(b.event_at || '').localeCompare(String(a.event_at || '')) || String(b.event_key || '').localeCompare(String(a.event_key || '')));
            return { data: range ? rows.slice(range[0], range[1] + 1) : rows, count: rows.length, error: null };
        };
        const chain: any = { select: () => chain, eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
            in: (key: string, values: any[]) => { membership[key] = values; return chain; }, order: () => chain,
            range: (start: number, end: number) => { range = [start, end]; return chain; },
            maybeSingle: async () => ({ data: result().data[0] || null, error: null }),
            then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject) };
        return chain;
    } };
}

describe('contact ad-source evidence', () => {
    it('keeps the referral creative separate from a newer catalog video and post', () => {
        const result = sourceCreative('100', ad, origin.referral)!;
        expect(result).toMatchObject({ photo_url: 'https://example.com/original.jpg', video_url: null, post_id: '10_20', post_permalink_url: null, creative_basis: 'referral_snapshot' });
        expect(result.catalog_preview.video_url).toBe('https://example.com/latest.mp4');
        expect(sourceCreative('100', ad, {})!.creative_basis).toBe('catalog');
        expect(sourceCreative('100', { photo_url: 'javascript:bad' }, {})!.photo_url).toBeNull();
    });
    it('does not turn a later click, a standalone referral or conflicting evidence into an origin', () => {
        expect(describeSourceTouch(later, source, ad).role).toBe('later_touch');
        expect(describeSourceTouch({ ...origin, event_key: 'other' }, source, ad).role).toBe('unconfirmed_touch');
        expect(describeSourceTouch(origin, { ...source, attribution_status: 'conflicting_sources' }, ad).role).toBe('unconfirmed_touch');
        expect(describeSourceTouch({ ...origin, message_id: 'postback:hash' }, source, ad).message_id).toBeNull();
    });
    it('loads campaign, ad set, creative and exact referral evidence using only the selected Page catalog', async () => {
        const db = database(), result = (await getContactSources(db, 'page', 'contact'))!;
        expect(result.origin!.ad).toMatchObject({ ad_name: 'Campaign ad', campaign_id: '300', adset_id: '400', creative_id: '500' });
        expect(result.origin!.evidence).toMatchObject({ event_key: 'origin', source: 'ADS', referral_type: 'OPEN_THREAD', referral_code: 'campaign-code', message_id: 'message-1' });
        expect(result.touches[0].ad!.ad_name).toBe('Return ad'); expect(result.touches[0].role).toBe('later_touch');
        expect(JSON.stringify(result)).not.toContain('Other Page private ad');
        for (const call of db.calls) { expect(call.filters.page_id).toBe('page'); if (call.table !== 'contacts' && call.table !== 'ad_source_catalog') expect(call.filters.contact_id).toBe('contact'); }
    });
    it('keeps unknown/conflicting origin statuses even when referral ads and creative metadata exist', async () => {
        for (const status of ['unknown', 'conflicting_sources']) {
            const result = (await getContactSources(database({ ad_contact_sources: [{ ...source, attribution_status: status }] }), 'page', 'contact'))!;
            expect(result.origin).toBeNull(); expect(result.attribution_status).toBe(status); expect(result.touches).toHaveLength(2);
        }
    });
    it('paginates all touches and loads origin evidence even when it is outside the visible page', async () => {
        const events = [origin, ...Array.from({ length: 30 }, (_, index) => ({ ...later, event_key: `later-${index}` }))];
        const db = database({ ad_referral_events: events });
        const first = (await getContactSources(db, 'page', 'contact'))!, second = (await getContactSources(db, 'page', 'contact', { page: 2 }))!;
        expect(first.total).toBe(31); expect(first.touches).toHaveLength(25); expect(first.origin!.evidence!.event_key).toBe('origin');
        expect(second.touches).toHaveLength(6);
        const focused = (await getContactSources(db, 'page', 'contact', { eventKey: 'origin' }))!;
        expect(focused.total).toBe(1); expect(focused.touches[0].role).toBe('origin');
    });
    it('returns no data for a contact outside the Page before loading source records', async () => {
        const db = database(); expect(await getContactSources(db, 'foreign', 'contact')).toBeNull(); expect(db.calls).toHaveLength(1);
    });
});
