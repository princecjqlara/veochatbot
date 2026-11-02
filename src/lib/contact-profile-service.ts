import { getChatbotDetailProgress } from '@/lib/chatbot-form-progress';
import { contactControls } from '@/lib/contact-controls';
import { hoursBetween, purchaseMetrics, type PurchaseRecord, type VerifiedPayment } from '@/lib/contact-profile-evidence';
import { profileAdFields } from '@/lib/contact-profile-sources';

type Db = { from: (table: string) => any; rpc: (name: string, args: Record<string, unknown>) => any };
const jobFields = 'status,reason,requested_version,working_version,scan_started,history_complete,message_count,analyzed_count,error_message,requested_at,updated_at';

export async function getContactProfile(db: Db, pageId: string, contactId: string) {
    const results = await Promise.all([
        db.from('contacts').select('*,contact_tags(tags(id,name,color,system_key,is_default))').eq('id', contactId).eq('page_id', pageId).maybeSingle(),
        db.from('pages').select('id,name,fb_page_id,messaging_auto_tag_checked_at,messaging_auto_tag_last_error').eq('id', pageId).maybeSingle(),
        db.from('chatbot_configs').select('*').eq('page_id', pageId).maybeSingle(),
        db.from('chatbot_contact_states').select('*').eq('page_id', pageId).eq('contact_id', contactId).maybeSingle(),
        db.from('contact_profile_snapshots').select('*').eq('page_id', pageId).eq('contact_id', contactId).order('generation', { ascending: false }).limit(1).maybeSingle(),
        db.from('contact_profile_jobs').select(jobFields).eq('page_id', pageId).eq('contact_id', contactId).maybeSingle(),
        db.from('ad_contact_sources').select('*').eq('page_id', pageId).eq('contact_id', contactId).maybeSingle(),
        db.rpc('get_contact_finance_records', { p_page_id: pageId, p_contact_id: contactId }),
        db.from('messenger_lead_stage_events').select('id,label,stage,occurred_at,observed_at,message_id,applied').eq('page_id', pageId).eq('contact_id', contactId).order('occurred_at').limit(1000),
        db.from('ad_lead_stage_events').select('id,previous_stage,stage,source,stage_timestamp,recorded_at').eq('page_id', pageId).eq('contact_id', contactId).order('recorded_at').limit(1000),
        db.from('ad_referral_events').select('event_key,event_at,event_kind,ad_id').eq('page_id', pageId).eq('contact_id', contactId).order('event_at').limit(500)
    ]);
    if (results.some(result => result.error)) throw new Error('Contact profile sources are temporarily unavailable');
    const [contactResult, pageResult, configResult, stateResult, snapshotResult, jobResult, adResult, financeResult, metaResult, stageResult, touchesResult] = results;
    const contact = contactResult.data;
    if (!contact || !pageResult.data) return null;
    const snapshot = snapshotResult.data, conversation = snapshot?.payload?.conversation || null;
    const finance = financeResult.data || { purchases: [], payments: [] };
    const verifiedOriginAt = /^(?:live_|audited_|verified_)/.test(adResult.data?.inquiry_basis || '') ? adResult.data.first_inquiry_at : null;
    const firstCandidates = [conversation?.first_inquiry_at, verifiedOriginAt].filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value)));
    const firstInquiryAt = firstCandidates.sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
    const metrics = purchaseMetrics(finance.purchases as PurchaseRecord[], finance.payments as VerifiedPayment[], firstInquiryAt);
    const meta: any[] = metaResult.data || [], stages: any[] = stageResult.data || [];
    // A late historical notice remains evidence even when a newer local stage
    // meant it did not overwrite the pipeline when imported.
    const conversions = [...meta.filter(event => event.stage === 'converted').map(event => event.occurred_at),
        ...stages.filter(event => event.stage === 'converted' && event.previous_stage && event.previous_stage !== 'converted' && event.source !== 'messenger').map(event => event.stage_timestamp)]
        .filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(a) - Date.parse(b));
    const firstConvertedAt = conversions[0] || null;
    const followUps: any[] = conversation?.tracked_follow_ups || [];
    const countBefore = (date: string | null) => date && conversation
        ? followUps.filter(event => Date.parse(event.at) < Date.parse(date) && (!firstInquiryAt || Date.parse(event.at) >= Date.parse(firstInquiryAt))).length : null;
    const before = [metrics.first_payment_at, conversation?.first_payment_ack_at].filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    const controls = (await contactControls(db, pageId, [contactId])).get(contactId) || {};
    let priorPrediction: any = null, ad: any = null;
    if (before) {
        const prior = await db.from('contact_conversion_prediction_issues').select('prediction,issued_at,source_cutoff_at,model_version')
            .eq('page_id', pageId).eq('contact_id', contactId).lt('issued_at', before).lt('source_cutoff_at', before).order('issued_at', { ascending: false }).limit(1).maybeSingle();
        if (prior.error) throw new Error('Could not verify the historical forecast');
        priorPrediction = prior.data;
    }
    if (adResult.data?.origin_ad_id && adResult.data?.attribution_status === 'verified_inline') {
        const result = await db.from('ad_source_catalog').select(profileAdFields).eq('page_id', pageId).eq('ad_id', adResult.data.origin_ad_id).maybeSingle();
        if (result.error) throw new Error('Could not load verified ad attribution');
        ad = { ...result.data, ad_id: adResult.data.origin_ad_id, attribution_status: 'verified_inline', evidence_key: adResult.data.origin_evidence_key };
    }
    const events: any[] = [];
    if (firstInquiryAt) events.push({ id: 'first-inquiry', type: 'inquiry', at: firstInquiryAt, title: 'First known customer inquiry', basis: firstInquiryAt === conversation?.first_inquiry_at ? 'Conversation source' : 'Verified inquiry attribution' });
    for (const event of meta) events.push({ id: `meta-${event.id}`, type: 'stage', at: event.occurred_at, title: `Meta stage: ${event.label}`, message_id: event.message_id, basis: event.applied ? 'Applied stage event' : 'Historical event; newer decision retained' });
    for (const event of stages) {
        if (event.source === 'messenger' && meta.some(item => item.stage === event.stage && Math.abs(Date.parse(item.observed_at) - Date.parse(event.recorded_at)) < 5000)) continue;
        events.push({ id: `crm-${event.id}`, type: 'stage', at: event.stage_timestamp || event.recorded_at, title: `Pipeline: ${event.stage.replaceAll('_', ' ')}`, basis: event.source || 'Recorded stage' });
    }
    for (const order of metrics.orders) events.push({ id: `purchase-${order.id}`, type: 'purchase', at: order.purchased_at, title: `Recorded order: ${order.description}`, amount_minor: order.total_minor, currency: order.currency, basis: 'Staff-entered order; payment tracked separately' });
    for (const payment of finance.payments) events.push({ id: `payment-${payment.id}`, type: 'payment', at: payment.occurred_at, title: `${payment.voided_at ? 'Voided ' : ''}${payment.kind} payment`, amount_minor: payment.amount_minor, currency: payment.currency, basis: payment.voided_at ? payment.void_reason : 'Staff verified against payment records' });
    for (const evidence of conversation?.payment_evidence || []) events.push({ id: `evidence-${evidence.message_id}`, type: 'chat_payment', at: evidence.at, title: evidence.acknowledgment ? 'Payment acknowledged in chat' : 'Payment statement in chat', message_id: evidence.message_id, basis: 'Conversation evidence; separate from verified payments' });
    for (const invoice of conversation?.invoice_requests || []) events.push({ id: `invoice-${invoice.reference}`, type: 'invoice', at: invoice.at, title: `Invoice requested: ${invoice.reference}`, message_id: invoice.message_id, basis: 'Payment request, not proof of payment' });
    for (const followUp of followUps) events.push({ id: `followup-${followUp.message_id}`, type: 'follow_up', at: followUp.at, title: 'Follow-up sent', message_id: followUp.message_id, basis: followUp.source });
    for (const touch of touchesResult.data || []) events.push({ id: `ad-${touch.event_key}`, type: 'ad', at: touch.event_at, title: touch.ad_id ? `Ad touch: ${touch.ad_id}` : 'Referral touch', basis: touch.event_kind, source_event_key: touch.event_key });
    events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const extracted = Object.fromEntries((snapshot?.payload?.extracted_answers || []).map((answer: any) => [answer.field, answer.value]));
    const saved = getChatbotDetailProgress(configResult.data, stateResult.data?.collected_details);
    const combinedDetails = { ...extracted, ...saved.collected_details };
    const conflicts = (snapshot?.payload?.extracted_answers || []).filter((answer: any) => saved.collected_details[answer.field] && saved.collected_details[answer.field] !== answer.value);
    return { contact: { ...contact, tags: (contact.contact_tags || []).map((assignment: any) => assignment.tags).filter(Boolean), contact_tags: undefined },
        page: pageResult.data, state: stateResult.data, detail_progress: getChatbotDetailProgress(configResult.data, combinedDetails),
        saved_detail_keys: Object.keys(saved.collected_details), answer_conflicts: conflicts,
        snapshot, job: jobResult.data, source_stale: Boolean(snapshot && [contact.last_interaction_at, contact.pipeline_stage_updated_at].some(value => value && Date.parse(value) > Date.parse(snapshot.source_cutoff_at))),
        first_inquiry_at: firstInquiryAt, first_recorded_conversion_at: firstConvertedAt,
        inquiry_to_conversion_hours: hoursBetween(firstInquiryAt, firstConvertedAt),
        finance: { ...finance, metrics },
        follow_up_metrics: { tracked_total: followUps.length, before_first_order: countBefore(metrics.orders[0]?.purchased_at || null), before_first_payment: countBefore(metrics.first_payment_at),
            before_deposit: countBefore(metrics.first_deposit_at), before_converted_stage: countBefore(firstConvertedAt),
            coverage: conversation ? 'Only messages with recorded follow-up attribution are counted' : 'Conversation analysis is not ready' },
        ad: ad || { attribution_status: adResult.data?.attribution_status || 'unknown' }, ad_touches: touchesResult.data || [],
        timeline: events, timeline_limited: meta.length >= 1000 || stages.length >= 1000 || (touchesResult.data || []).length >= 500,
        controls, projection_comparison: { prior: priorPrediction, actual_payment_at: metrics.first_payment_at,
            acknowledgment_at: conversation?.first_payment_ack_at || null,
            comparison_basis: 'The existing model forecasts a chat payment/deposit acknowledgment. It does not predict bank settlement or repeat purchases. Only forecasts issued before the outcome are eligible for comparison.' } };
}
