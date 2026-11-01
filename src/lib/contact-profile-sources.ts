import { safeAdMediaUrl } from '@/lib/ad-attribution';

type Db = { from: (table: string) => any };
export const profileAdFields = 'ad_id,ad_name,ad_title,photo_url,video_url,post_id,post_permalink_url,creative_id,creative_name,campaign_id,campaign_name,adset_id,adset_name,ad_account_id,ad_status,metadata_source,metadata_status,metadata_checked_at';
const eventFields = 'event_key,event_at,received_at,event_kind,message_id,ad_id,referral';
const text = (value: unknown, limit = 2000) => typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
const numeric = (value: unknown) => typeof value === 'string' && /^\d{1,100}$/.test(value) ? value : null;

/** Referral snapshots describe the observed creative; the catalog describes the latest saved ad. */
export function sourceCreative(adId: string | null, catalog: any, referral: any) {
    if (!adId) return null;
    const context = referral?.ads_context_data || {};
    const photo = safeAdMediaUrl(context.photo_url), video = safeAdMediaUrl(context.video_url);
    const catalogPhoto = safeAdMediaUrl(catalog?.photo_url), catalogVideo = safeAdMediaUrl(catalog?.video_url);
    const recordedMedia = Boolean(photo || video);
    const postId = typeof context.post_id === 'string' && /^\d+(?:_\d+)?$/.test(context.post_id) ? context.post_id : null;
    return { ...(catalog || {}), ad_id: adId, ad_title: text(context.ad_title, 500) || catalog?.ad_title || null,
        photo_url: recordedMedia ? photo : catalogPhoto,
        video_url: recordedMedia ? video : catalogVideo,
        post_id: recordedMedia ? postId : catalog?.post_id || postId || null,
        // A later catalog post must never be presented as the historical referral's post.
        post_permalink_url: recordedMedia ? null : safeAdMediaUrl(catalog?.post_permalink_url),
        recorded_ad_title: text(context.ad_title, 500), recorded_post_id: postId,
        catalog_preview: recordedMedia && (catalogPhoto || catalogVideo) ? { ...catalog, photo_url: catalogPhoto, video_url: catalogVideo } : null,
        creative_basis: recordedMedia ? 'referral_snapshot' : catalogPhoto || catalogVideo ? 'catalog' : 'unavailable' };
}

export function describeSourceTouch(event: any, source: any, catalog: any) {
    const referral = event.referral || {}, adId = numeric(event.ad_id);
    const verifiedFirst = /^(?:live_|verified_|audited_)/.test(source?.inquiry_basis || '') ? source?.first_inquiry_at : null;
    const role = source?.attribution_status === 'verified_inline' && source?.origin_evidence_key === event.event_key && source?.origin_ad_id === adId
        ? 'origin' : verifiedFirst && Date.parse(event.event_at) > Date.parse(verifiedFirst) ? 'later_touch' : 'unconfirmed_touch';
    return { event_key: event.event_key, at: event.event_at, received_at: event.received_at, event_kind: event.event_kind,
        message_id: typeof event.message_id === 'string' && !event.message_id.startsWith('postback:') ? event.message_id : null,
        role, source: text(referral.source, 100), referral_type: text(referral.type, 100), referral_code: text(referral.ref),
        ad: sourceCreative(adId, catalog, referral) };
}

export async function getContactSources(db: Db, pageId: string, contactId: string, input: { page?: number; eventKey?: string } = {}) {
    const page = input.eventKey ? 1 : Math.max(1, Math.min(10000, Math.trunc(input.page || 1))), pageSize = 25;
    const contact = await db.from('contacts').select('id').eq('page_id', pageId).eq('id', contactId).maybeSingle();
    if (contact.error) throw Error('Could not verify contact access');
    if (!contact.data) return null;
    let query = db.from('ad_referral_events').select(eventFields, { count: 'exact' }).eq('page_id', pageId).eq('contact_id', contactId);
    if (input.eventKey) query = query.eq('event_key', input.eventKey);
    const [sourceResult, eventsResult] = await Promise.all([
        db.from('ad_contact_sources').select('first_inquiry_at,first_message_id,first_event_key,inquiry_basis,origin_ad_id,origin_evidence_key,attribution_status,updated_at')
            .eq('page_id', pageId).eq('contact_id', contactId).maybeSingle(),
        query.order('event_at', { ascending: false }).order('event_key', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1)
    ]);
    if (sourceResult.error || eventsResult.error) throw Error('Could not read recorded source evidence');
    const source = sourceResult.data, events: any[] = eventsResult.data || [];
    const verifiedOrigin = source?.attribution_status === 'verified_inline' ? numeric(source.origin_ad_id) : null;
    let evidence = events.find(event => event.event_key === source?.origin_evidence_key) || null;
    if (verifiedOrigin && source?.origin_evidence_key && !evidence) {
        const result = await db.from('ad_referral_events').select(eventFields).eq('page_id', pageId).eq('contact_id', contactId)
            .eq('event_key', source.origin_evidence_key).maybeSingle();
        if (result.error) throw Error('Could not verify originating referral');
        evidence = result.data;
    }
    const ids = [...new Set([verifiedOrigin, ...events.map(event => numeric(event.ad_id))].filter((id): id is string => Boolean(id)))];
    const catalog = new Map<string, any>();
    if (ids.length) {
        const result = await db.from('ad_source_catalog').select(profileAdFields).eq('page_id', pageId).in('ad_id', ids);
        if (result.error) throw Error('Could not load recorded creatives');
        for (const ad of result.data || []) catalog.set(ad.ad_id, ad);
    }
    const originEvidence = evidence && evidence.ad_id === verifiedOrigin ? evidence : null;
    return { attribution_status: source?.attribution_status || 'unknown', first_inquiry_at: source?.first_inquiry_at || null,
        inquiry_basis: source?.inquiry_basis || 'not_recorded', attribution_updated_at: source?.updated_at || null,
        origin: verifiedOrigin ? { ad: sourceCreative(verifiedOrigin, catalog.get(verifiedOrigin), originEvidence?.referral),
            evidence: originEvidence ? describeSourceTouch(originEvidence, source, catalog.get(verifiedOrigin)) : null } : null,
        touches: events.map(event => describeSourceTouch(event, source, catalog.get(event.ad_id))), total: eventsResult.count || 0, page, page_size: pageSize,
        coverage: 'Only recorded Facebook referral evidence is shown. A later click does not establish the originating ad, and missing attribution does not prove an organic source.' };
}
