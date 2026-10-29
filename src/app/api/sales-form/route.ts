import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifySalesFormToken, mergeSalesRecord, queueSalesFormResponse } from '@/lib/chatbot-sales-store';
import { normalizeSalesDetails, salesDetailProgress, salesSettings, usesSalesAssistant, type SalesSettings } from '@/lib/chatbot-sales-assistant';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
function formValues(value: unknown, settings: SalesSettings) {
    const details = normalizeSalesDetails(value, settings);
    return Object.fromEntries(settings.fields.filter(field => field.enabled && details[field.label]).map(field => [field.label, details[field.label]]));
}
async function context(request: NextRequest) {
    const identity = verifySalesFormToken(request.nextUrl.searchParams.get('token') || '');
    if (!identity) return { error: NextResponse.json({ error: 'This form link has expired or is invalid. Request the form again in chat.' }, { status: 401, headers }) };
    const db = getSupabaseAdmin();
    const [config, contact, state] = await Promise.all([
        db.from('chatbot_configs').select('*').eq('page_id', identity.pageId).maybeSingle(),
        db.from('contacts').select('id,last_inbound_at,chatbot_enabled,pipeline_stage,pipeline_stage_source').eq('id', identity.contactId).eq('page_id', identity.pageId).maybeSingle(),
        db.from('chatbot_contact_states').select('collected_details,sales_progress,status').eq('page_id', identity.pageId).eq('contact_id', identity.contactId).maybeSingle()
    ]);
    if (config.error || contact.error || state.error) throw new Error('Could not load the customer form');
    if (!contact.data || !config.data || !usesSalesAssistant(config.data)) return { error: NextResponse.json({ error: 'This form is unavailable.' }, { status: 404, headers }) };
    const settings = salesSettings(config.data.sales_assistant_settings);
    return { db, identity, settings, config: config.data, contact: contact.data, state: state.data, snapshot: {
        fields: settings.fields.filter(field => field.enabled), details: formValues(state.data?.collected_details, settings),
        suggestions: state.data?.sales_progress?.assumptions || {}, progress: salesDetailProgress(state.data?.collected_details, settings)
    } };
}
export async function GET(request: NextRequest) {
    try { const ctx = await context(request); return ctx.error || NextResponse.json(ctx.snapshot, { headers }); }
    catch { return NextResponse.json({ error: 'The form could not be loaded. You can continue in chat.' }, { status: 503, headers }); }
}
export async function POST(request: NextRequest) {
    try {
        if (request.headers.get('origin') && request.headers.get('origin') !== request.nextUrl.origin) return NextResponse.json({ error: 'Invalid form origin' }, { status: 403, headers });
        if (Number(request.headers.get('content-length') || 0) > 24000) return NextResponse.json({ error: 'Form is too large' }, { status: 413, headers });
        const ctx = await context(request); if (ctx.error) return ctx.error;
        const raw = await request.text();
        if (raw.length > 24000) return NextResponse.json({ error: 'Form is too large' }, { status: 413, headers });
        let body;
        try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'Invalid form data' }, { status: 400, headers }); }
        if (!body || typeof body !== 'object' || !body.details || !body.base || typeof body.event_key !== 'string' || !/^[a-zA-Z0-9-]{10,80}$/.test(body.event_key)) {
            return NextResponse.json({ error: 'Invalid form submission' }, { status: 400, headers });
        }
        const allowed = ctx.settings.fields.filter(field => field.enabled).map(field => field.label);
        if (Object.entries(body.details).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string' || value.length > 500)) {
            return NextResponse.json({ error: 'Please check the form fields. Each answer can contain up to 500 characters.' }, { status: 400, headers });
        }
        const details = normalizeSalesDetails(body.details, ctx.settings);
        const now = new Date().toISOString();
        const result = await mergeSalesRecord(ctx.db, { ...ctx.identity, source: 'form', details,
            base: normalizeSalesDetails(body.base, ctx.settings), eventKey: 'form:' + body.event_key, observedAt: now,
            progress: { form_submitted_at: now, stage: ctx.state?.status === 'stopped' ? 'existing_human_handoff' : salesDetailProgress(details, ctx.settings).complete ? 'offer_presentation' : 'information_gathering' } });
        let responseQueued = false;
        if (!result.conflicts.length) {
            try { responseQueued = await queueSalesFormResponse(ctx.db, { ...ctx.identity, config: ctx.config, contact: ctx.contact, state: result.state }); }
            catch { /* Answers remain saved; a Messenger reply can still resume them. */ }
        }
        return NextResponse.json({ details: formValues(result.state.collected_details, ctx.settings),
            conflicts: result.conflicts, response_queued: responseQueued, progress: salesDetailProgress(result.state.collected_details, ctx.settings),
            message: result.conflicts.length ? 'Some answers changed in chat while this form was open. Review those fields and save again.' :
                'Saved po! Puwede na tayong magpatuloy sa chat. Your answers are available to the team.' },
        { status: result.conflicts.length ? 409 : 200, headers });
    } catch { return NextResponse.json({ error: 'Your answers could not be saved. Please try again or continue in chat.' }, { status: 503, headers }); }
}
