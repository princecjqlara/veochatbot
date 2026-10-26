import { describe, expect, it, vi } from 'vitest';
import { captureContactAdSource, parseAdSourceEvent } from '../ad-attribution';
const time = 1_790_000_000_000;
const event = (extra: any = {}) => ({ sender: { id: 'customer' }, recipient: { id: 'page' }, timestamp: time, message: { mid: 'mid-1', text: 'Interested', referral: { source: 'ADS', ad_id: '120999999999999999' } }, ...extra });
describe('ad source evidence', () => {
    it('keeps exact ad ID strings, first-message evidence and context without unsafe media', () => {
        const e = event(); e.message.referral.ads_context_data = { ad_title: 'Restaurant video', photo_url: 'javascript:alert(1)', video_url: 'https://example.com/preview.mp4', access_token: 'do-not-save' };
        const p = parseAdSourceEvent(e, 'page')!;
        expect(p.isInquiry).toBe(true); expect(p.referral.ad_id).toBe('120999999999999999'); expect(p.messageId).toBe('mid-1');
        expect(p.referral.ads_context_data).toEqual({ ad_title: 'Restaurant video', video_url: 'https://example.com/preview.mp4' });
    });
    it('does not count a thread-open referral as an inquiry', () => {
        expect(parseAdSourceEvent(event({ message: undefined, referral: { ad_id: '123', source: 'ADS', type: 'OPEN_THREAD' } }), 'page')?.isInquiry).toBe(false);
    });
    it('captures postback referrals and skips echoes, delivery receipts and missing timestamps', () => {
        expect(parseAdSourceEvent(event({ message: undefined, postback: { payload: 'GET_STARTED', referral: { ad_id: '123' } } }), 'page')?.referral.ad_id).toBe('123');
        expect(parseAdSourceEvent(event({ sender: { id: 'page' } }), 'page')).toBeNull();
        expect(parseAdSourceEvent(event({ message: { is_echo: true, text: 'Our reply' } }), 'page')).toBeNull();
        expect(parseAdSourceEvent(event({ message: undefined, delivery: { mids: ['m'] } }), 'page')).toBeNull();
        expect(parseAdSourceEvent(event({ timestamp: undefined }), 'page')).toBeNull();
    });
    it('deduplicates identical source events and rejects numeric ad IDs with possible precision loss', () => {
        expect(parseAdSourceEvent(event(), 'page')?.eventKey).toBe(parseAdSourceEvent(event(), 'page')?.eventKey);
        const e = event(); e.message.referral.ad_id = 123; expect(parseAdSourceEvent(e, 'page')?.referral.ad_id).toBeUndefined();
    });
    it('passes prior inquiry evidence so a returning ad click cannot replace acquisition', async () => {
        const rpc = vi.fn().mockResolvedValue({ error: null });
        await captureContactAdSource({ rpc }, { pageId: 'db-page', pageFacebookId: 'page', contactId: 'contact', event: event(), priorFirstAt: '2026-01-01T00:00:00Z' });
        expect(rpc).toHaveBeenCalledWith('record_contact_ad_event', expect.objectContaining({ p_prior_first_at: '2026-01-01T00:00:00Z', p_page_id: 'db-page', p_contact_id: 'contact' }));
    });
    it('does not acknowledge a source-save failure as successful capture', async () => {
        await expect(captureContactAdSource({ rpc: vi.fn().mockResolvedValue({ error: { message: 'secret internals' } }) }, { pageId: 'p', pageFacebookId: 'page', contactId: 'c', event: event() })).rejects.toThrow('Could not preserve ad-source evidence');
    });
});
