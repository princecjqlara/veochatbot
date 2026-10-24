import type { FacebookMessage } from '@/types';
import { getPricingPromotionDays } from '@/lib/chatbot-follow-up-timing';
import type { ChatbotConfig } from '@/lib/chatbot';
import { isCommercialVideoIntake } from '@/lib/chatbot-policy';
import { getCommercialVideoPriceList, isCommercialVideoPriceRequested, resolveCommercialVideoSalesFlow } from '@/lib/chatbot-sales-flow';
import { pricingOptionFreebies, withContactPricingKnowledge, type PricingDurationOption, type PricingCatalog } from '@/lib/chatbot-pricing-catalogs';
import { renderCommercialVideoPriceList } from '@/lib/chatbot-message-renderer';

export type PricingMode = 'fair_test' | 'sequence' | 'fair_test_sequence';
export type PricingPackageDraft = { name: string; price: number; message: string; hook?: string; options?: PricingDurationOption[] };
export type PricingExperimentDraft = {
    name: string;
    mode: PricingMode;
    duration_seconds: number | null;
    follow_up_gap_minutes: number;
    attribution_days: number;
    minimum_sample: number;
    packages: PricingPackageDraft[];
};
export type PricingOffer = {
    delivery_id: string;
    experiment_id: string;
    assignment_id: string;
    package_id: string;
    package_name: string;
    price: number;
    message: string;
    duration_seconds: number | null;
    kind: 'initial' | 'promotion';
    hook?: string;
    option?: PricingDurationOption | null;
    catalog?: PricingCatalog;
};
type PricingDb = { rpc?: (name: string, args: Record<string, unknown>) => any; from?: (table: string) => any };
export const PRICING_PACKAGE_HOLD_HOURS = 24;
export class PricingDeliveryUncertainError extends Error {}

export async function schedulePricingPromotion(db: PricingDb, input: {
    pageId: string; contactId: string; anchorInboundAt: string; days: number[]; bestHour?: number | null;
    automationEpoch?: number; policyRevision?: number;
}): Promise<{ managed: boolean; scheduled: number; due_at?: string; waiting_response?: boolean }> {
    if (!db.rpc) return { managed: false, scheduled: 0 };
    const result = await db.rpc('schedule_chatbot_pricing_promotion', {
        p_page_id: input.pageId, p_contact_id: input.contactId, p_anchor_inbound_at: input.anchorInboundAt,
        p_days: getPricingPromotionDays(input.days), p_best_hour: input.bestHour ?? 12,
        p_epoch: input.automationEpoch ?? 0, p_revision: input.policyRevision ?? 1
    });
    if (result.error) {
        if (['PGRST202', '42883'].includes(result.error.code)) return { managed: false, scheduled: 0 };
        throw new Error(result.error.message || 'Could not schedule the next pricing day');
    }
    return result.data?.managed === true ? result.data : { managed: false, scheduled: 0 };
}

export async function getContactPricingCatalog(db: PricingDb, pageId: string, contactId: string): Promise<PricingCatalog | null> {
    if (!db.rpc) return null;
    const result = await db.rpc('get_chatbot_pricing_contact_catalog', { p_page_id: pageId, p_contact_id: contactId });
    if (result.error) {
        if (['PGRST202', '42883'].includes(result.error.code)) return null;
        throw new Error(result.error.message || 'Could not verify the customer pricing catalog');
    }
    return result.data?.options?.length ? result.data : null;
}

/** Reject invalid catalogs instead of silently dropping a variant or changing its price. */
export function validatePricingExperiment(value: unknown): PricingExperimentDraft {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide a pricing experiment');
    const input = value as Record<string, unknown>;
    const text = (value: unknown, label: string, max: number) => {
        if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${label} must be 1–${max} characters`);
        return value.trim();
    };
    const integer = (value: unknown, label: string, min: number, max: number) => {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
        return value;
    };
    if (!['fair_test', 'sequence', 'fair_test_sequence'].includes(String(input.mode))) throw new Error('Choose a supported pricing mode');
    if (!Array.isArray(input.packages) || input.packages.length < (input.mode === 'sequence' ? 1 : 2) || input.packages.length > 10) {
        throw new Error(input.mode === 'sequence' ? 'Add 1–10 packages' : 'A fair test needs 2–10 packages');
    }
    const amount = (value: unknown) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
            throw new Error('Package price must be positive, with at most two decimal places');
        }
        return value;
    };
    const packages = input.packages.map((item: unknown): PricingPackageDraft => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid package');
        const row = item as Record<string, unknown>;
        let options: PricingDurationOption[] | undefined;
        if (row.options !== undefined && (!Array.isArray(row.options) || row.options.length > 20)) throw new Error('Add up to 20 duration options per catalog');
        if (Array.isArray(row.options) && row.options.length) {
            options = row.options.map((value: unknown) => {
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid duration option');
                const option = value as Record<string, unknown>;
                const price = amount(option.price);
                if (price < 150) throw new Error('Video catalog prices must cover the existing PHP150 down payment');
                return {
                    duration_seconds: integer(option.duration_seconds, 'Option duration', 1, 3600), price,
                    addon_videos: integer(option.addon_videos, '8-second add-on count', 0, 100),
                    posters: integer(option.posters, 'Poster count', 0, 100), captions: integer(option.captions, 'Caption count', 0, 100),
                    ...(option.bonus_video_seconds == null ? {} : { bonus_video_seconds: integer(option.bonus_video_seconds, 'Extra bonus video duration', 1, 3600) }),
                    ...(option.package_name ? { package_name: text(option.package_name, 'Duration package name', 80) } : {}),
                    ...(option.regular_price == null ? {} : { regular_price: amount(option.regular_price) })
                };
            }).sort((a, b) => a.duration_seconds - b.duration_seconds);
            if (new Set(options.map(option => option.duration_seconds)).size !== options.length) throw new Error('Each catalog duration must be unique');
        }
        return { name: text(row.name, 'Package name', 80), price: options ? options[0].price : amount(row.price),
            message: options && !row.message ? '' : text(row.message, 'Offer details', 1200),
            ...(row.hook ? { hook: text(row.hook, 'Promotional hook', 160) } : {}), ...(options ? { options } : {}) };
    });
    if (new Set(packages.map(row => row.name.toLowerCase())).size !== packages.length) throw new Error('Package names must be unique');
    if (packages.some(row => row.options?.length)) {
        const durations = packages[0].options?.map(option => option.duration_seconds).join(',');
        if (!durations || packages.some(row => row.options?.map(option => option.duration_seconds).join(',') !== durations)) {
            throw new Error('All catalogs in a run must cover the same durations for a fair comparison');
        }
        if (input.duration_seconds != null && !packages[0].options?.some(option => option.duration_seconds === input.duration_seconds)) {
            throw new Error('The run duration must exist in every catalog');
        }
    }
    return {
        name: text(input.name, 'Experiment name', 100), mode: input.mode as PricingMode,
        duration_seconds: input.duration_seconds == null ? null : integer(input.duration_seconds, 'Duration', 1, 3600),
        follow_up_gap_minutes: integer(input.follow_up_gap_minutes, 'Follow-up spacing', 15, 1439),
        attribution_days: integer(input.attribution_days, 'Attribution window', 1, 90),
        minimum_sample: integer(input.minimum_sample, 'Minimum sample', 10, 10000), packages
    };
}

export function getPricingQuoteContext(input: {
    config: ChatbotConfig; pageId: string; history?: FacebookMessage[];
    inboundMessage?: string; collectedDetails?: Record<string, string>; hasClearRequest?: boolean;
}) {
    const priceRequested = isCommercialVideoPriceRequested(input.inboundMessage || '');
    if (!isCommercialVideoIntake(input.config)) return { eligible: priceRequested, durationSeconds: null };
    const flow = resolveCommercialVideoSalesFlow({ ...input, details: input.collectedDetails });
    return { eligible: flow.pricingReady === true, durationSeconds: flow.durationSeconds };
}

/** A missing additive migration preserves the existing chatbot behavior. Other errors fail closed. */
export async function reservePricingOffer(db: PricingDb, input: {
    pageId: string; contactId: string; sourceKey: string; followUp: boolean;
    quoteEligible: boolean; durationSeconds: number | null; enforceDiscovery?: boolean;
}): Promise<PricingOffer | null> {
    if (!db.rpc || (input.enforceDiscovery && !input.quoteEligible)) return null;
    const result = await db.rpc('reserve_chatbot_pricing_offer', {
        p_page_id: input.pageId, p_contact_id: input.contactId, p_source_key: input.sourceKey,
        p_follow_up: input.followUp, p_quote_eligible: input.quoteEligible, p_duration_seconds: input.durationSeconds
    });
    if (result.error) {
        if (['PGRST202', '42883'].includes(result.error.code)) return null;
        throw new Error(result.error.message || 'Could not select a pricing package');
    }
    if (result.data?.blocked) throw new PricingDeliveryUncertainError('Pricing delivery already sent or in progress; check its receipt before retrying');
    if (result.data && db.from) {
        // Read the reserved package itself: the last delivered catalog may be
        // different during an initial assignment or a later promotion.
        try {
            const catalog = await db.from('chatbot_pricing_packages').select('name,hook,price,message,options')
                .eq('id', result.data.package_id).eq('experiment_id', result.data.experiment_id).single();
            if (catalog.error || !catalog.data) throw new Error(catalog.error?.message || 'Could not load the complete reserved price list');
            return { ...result.data, catalog: catalog.data };
        } catch (error) {
            await releasePricingOffer(db, result.data);
            throw error;
        }
    }
    return result.data || null;
}

export function renderPricingOffer(offer: PricingOffer, input: {
    commercial?: boolean; contactName?: string | null; business?: string | null; followUp?: boolean;
} = {}): string {
    if (input.commercial) {
        if (!offer.catalog?.options?.length) throw new Error('Complete verified commercial price list is unavailable');
        const list = renderCommercialVideoPriceList(getCommercialVideoPriceList(withContactPricingKnowledge([], offer.catalog)), input.business || undefined);
        return list + (offer.kind === 'promotion' || input.followUp ? '\nMas bagay ba sa kailangan mo ang price list na ito?' : '');
    }
    const firstName = input.contactName?.trim().split(/\s+/)[0] || '';
    const details = offer.message.replaceAll('{first_name}', firstName).replaceAll('{business}', input.business || 'your business');
    return [
        input.commercial ? 'PRICING PARA SA ' + (input.business || 'VIDEO MO') : (offer.kind === 'promotion' ? 'Another package you can consider:' : 'Package details:'),
        offer.hook || '',
        offer.package_name + (offer.option?.package_name ? ' / ' + offer.option.package_name : '') + (offer.duration_seconds ? `: 1 ${offer.duration_seconds}-second main commercial video.` : '.'),
        (offer.option?.regular_price ? 'From PHP' + offer.option.regular_price.toLocaleString('en-US') + '. ' : '') + 'Package price: PHP' + Number(offer.price).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '.',
        offer.option && pricingOptionFreebies(offer.option) ? 'FREE: ' + pricingOptionFreebies(offer.option) + '.' : '',
        details,
        offer.option && input.commercial ? 'PHP150 down payment. Balance: PHP' + (Number(offer.price) - 150).toLocaleString('en-US') + '.' : '',
        input.commercial ? 'Walang bayad ang free concept o free script; hiwalay ang paid video production.' : '',
        offer.kind === 'promotion' || input.followUp ? (input.commercial ? 'Mas bagay ba sa kailangan mo ang package na ito?' : 'Would this package fit what you need?') : ''
    ].filter(Boolean).join('\n');
}

/** Replace the complete price answer, preserving the commercial process and next question. */
export function applyPricingOffer(messages: string[], offer: PricingOffer, input: Parameters<typeof renderPricingOffer>[1] = {}): string[] {
    if (!input.commercial) return [renderPricingOffer(offer, input)];
    const priceBlock = messages.findIndex(message => /PRICING PARA SA /i.test(message));
    if (priceBlock < 0) return messages;
    const copy = renderPricingOffer(offer, input);
    return messages.flatMap((message, index) => index === priceBlock ? [copy]
        : /PRICING PARA SA /i.test(message) ? [] : [message]);
}

export async function assertPricingOfferActive(db: PricingDb, offer: PricingOffer) {
    const result = await db.rpc!('chatbot_pricing_offer_is_active', { p_delivery_id: offer.delivery_id });
    if (result.error) throw new Error(result.error.message || 'Could not verify pricing settings');
    if (result.data !== true) throw new Error('Pricing experiment paused, replaced, or no longer eligible');
}

export async function recordPricingDelivery(db: PricingDb, offer: PricingOffer, messageId: string) {
    const result = await db.rpc!('finish_chatbot_pricing_delivery', { p_delivery_id: offer.delivery_id, p_message_id: messageId });
    if (result.error) throw new Error(result.error.message || 'Could not record package delivery');
}

/** Durable checkpoint before the network call. An ambiguous send must never be replayed automatically. */
export async function beginPricingDelivery(db: PricingDb, offer: PricingOffer) {
    const result = await db.rpc!('begin_chatbot_pricing_delivery', { p_delivery_id: offer.delivery_id });
    if (result.error) throw new Error(result.error.message || 'Could not checkpoint pricing delivery');
    if (result.data !== true) throw new PricingDeliveryUncertainError('Pricing offer is no longer available for sending');
}

export async function releasePricingOffer(db: PricingDb, offer: PricingOffer | null) {
    if (!offer || !db.rpc) return;
    const result = await db.rpc('release_chatbot_pricing_offer', { p_delivery_id: offer.delivery_id });
    if (result.error) console.warn('[CHATBOT_PRICING_RELEASE]', result.error.message);
}

export function pricingRate(numerator: number, denominator: number): number | null {
    return denominator > 0 ? Math.round(numerator / denominator * 10000) / 100 : null;
}
