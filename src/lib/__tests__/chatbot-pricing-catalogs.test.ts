import { describe, expect, it } from 'vitest';
import { currentPricingCatalog, OWNER_PRICING_CATALOGS, PRICING_CATALOG_DURATIONS } from '@/lib/chatbot-pricing-catalogs';
import { renderPricingOffer, validatePricingExperiment, type PricingOffer } from '@/lib/chatbot-pricing';
import { approvedCatalogContent } from './fixtures/pricing-catalogs';
import { hasForbiddenFreeVideoOffer } from '@/lib/chatbot-intake';

const knowledge = (content = approvedCatalogContent) => [{ chunk_id: 'chunk', document_id: 'document', title: 'Approved promo', similarity: 1, content }];
const draft = { name: 'Four catalogs', mode: 'fair_test', duration_seconds: null, follow_up_gap_minutes: 120,
    attribution_days: 7, minimum_sample: 100, packages: [currentPricingCatalog(knowledge()), ...OWNER_PRICING_CATALOGS] };

describe('owner-approved pricing catalogs', () => {
    it('allows only the approved bonus duration in later factual answers, without allowing free main videos', () => {
        expect(hasForbiddenFreeVideoOffer('Kasama ang FREE 1 extra 16-second bonus video.', 16)).toBe(false);
        expect(hasForbiddenFreeVideoOffer('Kasama ang FREE 1 extra 24-second bonus video.', 16)).toBe(true);
        expect(hasForbiddenFreeVideoOffer('Kasama ang FREE 2 extra 16-second bonus videos.', 16)).toBe(true);
        expect(hasForbiddenFreeVideoOffer('Gagawa kami ng free personalized commercial video.', 16)).toBe(true);
        expect(hasForbiddenFreeVideoOffer('Kasama ang FREE 1 extra 16-second bonus video.')).toBe(true);
    });
    it('preserves all 18 supplied prices under the three separate hooks', () => {
        expect(OWNER_PRICING_CATALOGS.map(catalog => catalog.hook)).toEqual([
            'PREMIUM ADS, PREMIUM FREEBIES, ONE PACKAGE!',
            'ISANG MAIN VIDEO + DALAWANG BONUS VIDEOS!',
            'MAS MARAMING ADS, MAS MARAMING WAYS TO PROMOTE!'
        ]);
        expect(OWNER_PRICING_CATALOGS.map(catalog => catalog.options.map(option => option.price))).toEqual([
            [999, 1199, 1499, 1799, 2299, 3699], [799, 999, 1299, 1499, 1899, 2999], [899, 1099, 1399, 1699, 2199, 3499]
        ]);
        expect(OWNER_PRICING_CATALOGS.map(catalog => catalog.options.map(option => option.duration_seconds))).toEqual([
            [...PRICING_CATALOG_DURATIONS], [...PRICING_CATALOG_DURATIONS], [...PRICING_CATALOG_DURATIONS]
        ]);
    });
    it('keeps the supplied freebie counts, including captions as separate counted items', () => {
        expect(OWNER_PRICING_CATALOGS.map(catalog => catalog.options.map(option => [option.addon_videos, option.posters, option.captions]))).toEqual([
            [[2,2,2],[3,2,2],[3,3,3],[4,3,3],[4,3,4],[5,4,5]],
            [[2,1,1],[2,2,2],[3,2,2],[3,3,3],[4,3,3],[5,4,4]],
            [[2,2,2],[3,2,2],[3,3,3],[4,3,3],[5,3,4],[6,4,5]]
        ]);
    });
    it('adds the extra 16s and 24s videos only to the two specified Premium options', () => {
        expect(OWNER_PRICING_CATALOGS.map(catalog => catalog.options.map(option => option.bonus_video_seconds || null))).toEqual([
            [null, null, null, null, 16, 24], [null, null, null, null, null, null], [null, null, null, null, null, null]
        ]);
    });
    it('loads the control from current knowledge instead of a historical preset', () => {
        const control = currentPricingCatalog(knowledge(approvedCatalogContent.replace('PHP899 | 1 x', 'PHP925 | 1 x')));
        expect(control.options[1]).toMatchObject({ price: 925, regular_price: 1099, package_name: 'Best Seller', addon_videos: 1, posters: 1, captions: 1 });
        expect(control.options).toHaveLength(6);
        expect(control.hook).toBe('');
    });
    it('requires a verified complete control instead of silently substituting another price', () => {
        expect(() => currentPricingCatalog(knowledge(approvedCatalogContent.replace('Current owner-approved promo catalog', 'Historical reference')))).toThrow('could not be verified');
        expect(() => currentPricingCatalog(knowledge(approvedCatalogContent.split('\n').filter(line => !line.includes('Full Campaign')).join('\n')))).toThrow('120-second');
    });
    it('validates four catalogs together without flattening their durations into test arms', () => {
        const result = validatePricingExperiment(draft);
        expect(result.packages).toHaveLength(4);
        expect(result.packages.every(pkg => pkg.options?.length === 6)).toBe(true);
        expect(result.packages[0].name).toContain('control');
    });
    it('rejects mismatched catalog coverage and duplicate duration choices', () => {
        const mismatch = structuredClone(draft);
        mismatch.packages[1].options.pop();
        expect(() => validatePricingExperiment(mismatch)).toThrow('same durations');
        const duplicate = structuredClone(draft);
        duplicate.packages[1].options.push(duplicate.packages[1].options[0]);
        expect(() => validatePricingExperiment(duplicate)).toThrow('duration must be unique');
    });
    it('requires scope to match a supported duration and keeps the existing deposit valid', () => {
        expect(() => validatePricingExperiment({ ...draft, duration_seconds: 30 })).toThrow('must exist');
        const invalidPrice = structuredClone(draft);
        invalidPrice.packages[1].options[0].price = 149;
        expect(() => validatePricingExperiment(invalidPrice)).toThrow('PHP150');
    });
    it.each([60, 120])('renders only the selected Premium %is row, preserving the hook, extras and balance', duration => {
        const catalog = OWNER_PRICING_CATALOGS[0];
        const option = catalog.options.find(option => option.duration_seconds === duration)!;
        const offer: PricingOffer = { delivery_id: 'delivery', experiment_id: 'run', assignment_id: 'assignment', package_id: 'premium',
            package_name: catalog.name, hook: catalog.hook, price: option.price, message: '', option, duration_seconds: duration, kind: 'initial' };
        const copy = renderPricingOffer(offer, { commercial: true });
        expect(copy).toContain(catalog.hook);
        expect(copy).toContain(`1 ${duration}-second main commercial video`);
        expect(copy).toContain(`1 extra ${duration === 60 ? 16 : 24}-second bonus video`);
        expect(copy).toContain(`${option.addon_videos} x 8-second add-on videos`);
        expect(copy).toContain(`${option.captions} captions`);
        expect(copy).toContain('Package price: PHP' + option.price.toLocaleString('en-US'));
        expect(copy).toContain('Balance: PHP' + (option.price - 150).toLocaleString('en-US'));
        expect(copy).not.toContain('More Ways to Promote');
    });
});
