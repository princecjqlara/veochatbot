import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { uuid } from '@/lib/veo-workspace';
import { allowedProfileField, contactIntelligence, profileFieldKey, profileFieldDefinitions } from '@/lib/veo-contact-intelligence';
import { demographicKey } from '@/lib/veo-demographics';
export const dynamic = 'force-dynamic';
async function handle(request: NextRequest, write: boolean) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
        if (write && request.headers.get('origin') !== request.nextUrl.origin) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
        const body = write ? await request.json() : {}, contact = write ? body.contact_id : request.nextUrl.searchParams.get('contact_id');
        if (!uuid(contact)) throw Error('Choose a contact');
        if (write && !['refresh', 'request'].includes(body.action)) throw Error('Choose a profile action');
        const db = getSupabaseAdmin(), args = { p_actor: session.user.id, p_contact: contact };
        let result = await db.rpc('veo_profile_detail_access', args), duplicate = false;
        if (result.error) throw Object.assign(new Error('Contact profile access is unavailable'), { status: result.error.code === '42501' ? 403 : 503 });
        if (write && body.action === 'refresh') result = await db.rpc('veo_demographic_action', { ...args, p_action: 'refresh', p_fields: {} });
        if (write && body.action === 'request') {
            if (!allowedProfileField(body.label)) throw Error('Use a customer detail label of 2–80 characters; financial and account-control fields use verified records');
            const key = profileFieldKey(body.label);
            const existing = [...profileFieldDefinitions(result.data.chatbot_fields, result.data.requested_fields).map(f => f.key), ...Object.keys(result.data.manual_fields || {}).map(profileFieldKey), ...Object.keys(result.data.saved_fields || {}).map(profileFieldKey)];
            duplicate = Boolean(demographicKey(key) || existing.includes(key));
            if (!duplicate && (result.data.requested_fields || []).length >= 20) throw Error('Use at most 20 additional customer details');
            if (!duplicate) result = await db.rpc('veo_profile_detail_request', { ...args, p_fields: [{ key, label: body.label.trim() }] });
        }
        if (result.error) throw Object.assign(new Error('Could not update profile auto-fill'), { status: result.error.code === '42501' ? 403 : 503 });
        if (write && body.action === 'refresh') result = await db.rpc('veo_profile_detail_access', args);
        if (result.error) throw Object.assign(new Error('Profile auto-fill is unavailable'), { status: 503 });
        return NextResponse.json({ ...contactIntelligence(result.data), duplicate }, { status: write && !duplicate ? 202 : 200, headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) { return NextResponse.json({ error: e.message || 'Profile auto-fill unavailable' }, { status: e.status || 400, headers: { 'Cache-Control': 'no-store' } }); }
}
export const GET = (r: NextRequest) => handle(r, false);
export const POST = (r: NextRequest) => handle(r, true);
