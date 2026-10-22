import type { ChatbotKnowledgeMatch } from '@/lib/chatbot-knowledge';
import { getCommercialVideoPricing } from '@/lib/chatbot-sales-flow';

export const PRICING_CATALOG_DURATIONS = [16, 24, 32, 40, 60, 120] as const;

export type PricingDurationOption = {
    duration_seconds: number;
    price: number;
    addon_videos: number;
    posters: number;
    captions: number;
    bonus_video_seconds?: number;
    package_name?: string;
    regular_price?: number;
};

export type PricingCatalog = {
    name: string;
    hook: string;
    price: number;
    message: string;
    options: PricingDurationOption[];
};

function catalog(name: string, hook: string, rows: number[][]): PricingCatalog {
    return { name, hook, price: rows[0][1], message: '', options: rows.map(row => ({
        duration_seconds: row[0], price: row[1], addon_videos: row[2], posters: row[3], captions: row[4],
        ...(row[5] ? { bonus_video_seconds: row[5] } : {})
    })) };
}

/** Exact additional catalogs supplied by the owner. The existing catalog is loaded separately. */
export const OWNER_PRICING_CATALOGS: PricingCatalog[] = [
    catalog('Premium Ads', 'PREMIUM ADS, PREMIUM FREEBIES, ONE PACKAGE!', [
        [16, 999, 2, 2, 2], [24, 1199, 3, 2, 2], [32, 1499, 3, 3, 3], [40, 1799, 4, 3, 3],
        [60, 2299, 4, 3, 4, 16], [120, 3699, 5, 4, 5, 24]
    ]),
    catalog('Main + Bonus Videos', 'ISANG MAIN VIDEO + DALAWANG BONUS VIDEOS!', [
        [16, 799, 2, 1, 1], [24, 999, 2, 2, 2], [32, 1299, 3, 2, 2], [40, 1499, 3, 3, 3],
        [60, 1899, 4, 3, 3], [120, 2999, 5, 4, 4]
    ]),
    catalog('More Ways to Promote', 'MAS MARAMING ADS, MAS MARAMING WAYS TO PROMOTE!', [
        [16, 899, 2, 2, 2], [24, 1099, 3, 2, 2], [32, 1399, 3, 3, 3], [40, 1699, 4, 3, 3],
        [60, 2199, 5, 3, 4], [120, 3499, 6, 4, 5]
    ])
];

export function pricingOptionFreebies(option: PricingDurationOption): string {
    return [
        option.addon_videos ? `${option.addon_videos} x 8-second add-on video${option.addon_videos === 1 ? '' : 's'}` : '',
        option.bonus_video_seconds ? `1 extra ${option.bonus_video_seconds}-second bonus video` : '',
        option.posters ? `${option.posters} poster${option.posters === 1 ? '' : 's'}` : '',
        option.captions ? `${option.captions} caption${option.captions === 1 ? '' : 's'}` : ''
    ].filter(Boolean).join(' + ');
}

/** Snapshot the actual approved knowledge; never replace the control with a hard-coded historic rate. */
export function currentPricingCatalog(knowledge: ChatbotKnowledgeMatch[]): PricingCatalog {
    const approved = knowledge.filter(match => /current owner-approved promo catalog|owner-approved promo price list/i.test(match.content));
    const options = PRICING_CATALOG_DURATIONS.map(duration => {
        const rate = getCommercialVideoPricing(approved, duration);
        if (!rate || rate.referenceOnly || (rate.addonCount > 0 && rate.addonDurationSeconds !== 8)) {
            throw new Error(`The current approved ${duration}-second price could not be verified. Keep the existing catalog and check its knowledge source.`);
        }
        return { duration_seconds: duration, price: rate.pricePHP, addon_videos: rate.addonCount,
            posters: rate.posters, captions: rate.caption ? 1 : 0, package_name: rate.packageName,
            ...(rate.regularPricePHP ? { regular_price: rate.regularPricePHP } : {}) };
    });
    return { name: 'Current bot catalog (control)', hook: '', price: options[0].price, message: '', options };
}

export function withContactPricingKnowledge(knowledge: ChatbotKnowledgeMatch[], catalog?: PricingCatalog | null): ChatbotKnowledgeMatch[] {
    if (!catalog?.options?.length) return knowledge;
    return [{ chunk_id: '__contact_catalog__', document_id: '__contact_catalog__', title: 'Verified catalog for this customer', similarity: 1,
        contact_pricing_catalog: catalog,
        content: 'CONTACT-CATALOG: Current owner-approved promo catalog for this customer.\n' + JSON.stringify(catalog) }, ...knowledge];
}
