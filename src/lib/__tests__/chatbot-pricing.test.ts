import { describe, expect, it, vi } from 'vitest';
import { applyPricingOffer, assertPricingOfferActive, getPricingQuoteContext, pricingRate, renderPricingOffer, reservePricingOffer, schedulePricingPromotion, validatePricingExperiment, type PricingOffer } from '@/lib/chatbot-pricing';
import type { ChatbotConfig } from '@/lib/chatbot';

const draft = { name: 'October test', mode: 'fair_test_sequence', duration_seconds: 24, follow_up_gap_minutes: 120,
    attribution_days: 7, minimum_sample: 100, packages: [
        { name: 'Basic', price: 599, message: 'Main video for {business}.' },
        { name: 'Plus', price: 799, message: 'Main video with a poster.' }
    ] };
const offer: PricingOffer = { delivery_id: 'delivery', experiment_id: 'experiment', assignment_id: 'assignment',
    package_id: 'basic', package_name: 'Basic', price: 599, message: 'Hi {first_name}, includes a main video for {business}.',
    duration_seconds: 24, kind: 'initial' };

describe('pricing experiments', () => {
    it('uses built-in pricing days when ordinary later-day reminders are disabled', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { managed: true, scheduled: 1 } });
        await schedulePricingPromotion({ rpc }, { pageId: 'page', contactId: 'contact', anchorInboundAt: '2026-10-22T04:00:00Z', days: [] });
        expect(rpc).toHaveBeenCalledWith('schedule_chatbot_pricing_promotion', expect.objectContaining({ p_days: [2, 3, 5, 7], p_best_hour: 12 }));
    });
    it('passes later-day timing and automation scope to the pricing scheduler', async () => {
        const scheduled = { managed: true, scheduled: 1, waiting_response: true, due_at: '2026-10-23T04:00:00Z' };
        const rpc = vi.fn().mockResolvedValue({ data: scheduled });
        expect(await schedulePricingPromotion({ rpc }, { pageId: 'page', contactId: 'contact', anchorInboundAt: '2026-10-22T04:00:00Z',
            days: [2, 3, 5], bestHour: 15, automationEpoch: 3, policyRevision: 2 })).toEqual(scheduled);
        expect(rpc).toHaveBeenCalledWith('schedule_chatbot_pricing_promotion', { p_page_id: 'page', p_contact_id: 'contact',
            p_anchor_inbound_at: '2026-10-22T04:00:00Z', p_days: [2, 3, 5], p_best_hour: 15, p_epoch: 3, p_revision: 2 });
    });
    it('preserves exact approved prices and package order', () => {
        expect(validatePricingExperiment(draft)).toEqual(draft);
    });
    it.each([
        { mode: 'winner_automatically' }, { packages: draft.packages.slice(0, 1) },
        { packages: [{ ...draft.packages[0], price: -10 }, draft.packages[1]] },
        { packages: [{ ...draft.packages[0], price: 10.555 }, draft.packages[1]] },
        { packages: [{ ...draft.packages[0], price: NaN }, draft.packages[1]] },
        { packages: [draft.packages[0], { ...draft.packages[1], name: ' BASIC ' }] },
        { follow_up_gap_minutes: 0 }, { attribution_days: 0 }, { duration_seconds: 0 }, { minimum_sample: 1 },
        { packages: new Array(11).fill(draft.packages[0]) }
    ])('rejects invalid catalogs: %j', change => {
        expect(() => validatePricingExperiment({ ...draft, ...change })).toThrow();
    });
    it('allows one package for an ordered promotion', () => {
        expect(validatePricingExperiment({ ...draft, mode: 'sequence', packages: draft.packages.slice(0, 1) }).packages).toHaveLength(1);
    });
    it('does not treat zero exposed customers as a measured zero conversion rate', () => {
        expect(pricingRate(0, 0)).toBeNull();
        expect(pricingRate(1, 3)).toBe(33.33);
        expect(pricingRate(0, 3)).toBe(0);
    });
    it('replaces a complete commercial quote while retaining process and question', () => {
        const process = 'STEP-BY-STEP PROCESS PO:\n1. Small down payment muna, PHP150 will do.';
        const result = applyPricingOffer(['PRICING PARA SA BAKERY\nOld rate PHP999.', process, 'Gusto mo bang mag-proceed?'], offer,
            { commercial: true, contactName: 'CJ Lara', business: 'CJ Bakery' });
        expect(result).toHaveLength(3);
        expect(result[0]).toContain('PHP599');
        expect(result[0]).toContain('Hi CJ, includes a main video for CJ Bakery.');
        expect(result[0]).toContain('24-second');
        expect(result.join('\n')).not.toContain('PHP999');
        expect(result[1]).toBe(process);
        expect(result[2]).toBe('Gusto mo bang mag-proceed?');
    });
    it('leaves a non-pricing commercial answer alone', () => {
        const messages = ['Anong business mo?'];
        expect(applyPricingOffer(messages, offer, { commercial: true })).toBe(messages);
    });
    it('sends only the selected generic package', () => {
        expect(applyPricingOffer(['Old package PHP999', 'Other package PHP1999'], offer)).toEqual([renderPricingOffer(offer)]);
        const promo = renderPricingOffer({ ...offer, kind: 'promotion' });
        expect(promo).toContain('Would this package fit what you need?');
        expect(promo).not.toContain('undefined');
    });
    it('enrolls a general-product inquiry only when pricing is requested', () => {
        const config = { commercial_video_intake_enabled: false } as ChatbotConfig;
        expect(getPricingQuoteContext({ config, pageId: 'page', inboundMessage: 'Magkano?' }).eligible).toBe(true);
        expect(getPricingQuoteContext({ config, pageId: 'page', inboundMessage: 'Hello' }).eligible).toBe(false);
    });
    it('passes scope and idempotency to the database allocator', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: offer, error: null });
        expect(await reservePricingOffer({ rpc }, { pageId: 'page', contactId: 'customer', sourceKey: 'reply:mid',
            followUp: false, quoteEligible: true, durationSeconds: 24 })).toEqual(offer);
        expect(rpc).toHaveBeenCalledWith('reserve_chatbot_pricing_offer', {
            p_page_id: 'page', p_contact_id: 'customer', p_source_key: 'reply:mid',
            p_follow_up: false, p_quote_eligible: true, p_duration_seconds: 24
        });
    });
    it('preserves old deployments before the additive migration is installed', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
        expect(await reservePricingOffer({ rpc }, { pageId: 'page', contactId: 'customer', sourceKey: 'reply',
            followUp: false, quoteEligible: true, durationSeconds: null })).toBeNull();
    });
    it('does not fall back to another price on database failure', async () => {
        const rpc = vi.fn().mockResolvedValue({ error: { code: '57014', message: 'Database timeout' } });
        await expect(reservePricingOffer({ rpc }, { pageId: 'page', contactId: 'customer', sourceKey: 'reply',
            followUp: false, quoteEligible: true, durationSeconds: null })).rejects.toThrow('Database timeout');
    });
    it('rejects an offer paused during generation', async () => {
        await expect(assertPricingOfferActive({ rpc: vi.fn().mockResolvedValue({ data: false }) }, offer)).rejects.toThrow('paused');
    });
    it('never substitutes another offer for a source that has already attempted delivery', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { blocked: true } });
        await expect(reservePricingOffer({ rpc }, { pageId: 'page', contactId: 'customer', sourceKey: 'reply',
            followUp: false, quoteEligible: true, durationSeconds: null })).rejects.toThrow('check its receipt');
    });
});
