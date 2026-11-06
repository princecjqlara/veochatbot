import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { uuid } from '@/lib/veo-workspace';
import { demographicFields, recordedDemographics, validDemographicValue } from '@/lib/veo-demographics';
export const dynamic = 'force-dynamic';
async function handle(request: NextRequest, write: boolean) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
        if (write && request.headers.get('origin') !== request.nextUrl.origin) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
        const body = write ? await request.json() : {}, contact = write ? body.contact_id : request.nextUrl.searchParams.get('contact_id');
        if (!uuid(contact)) throw Error('Choose a contact');
        if (write && !['refresh', 'correct'].includes(body.action)) throw Error('Invalid demographic action');
        if (write && body.action === 'correct' && (!body.fields || Array.isArray(body.fields) || typeof body.fields !== 'object' || Object.entries(body.fields).some(([k, v]) => !demographicFields.some(f => f.key === k) || typeof v !== 'string' || v.length > 160 || v.trim() && !validDemographicValue(k, v)))) throw Error('Invalid demographic corrections');
        const args = { p_actor: session.user.id, p_contact: contact };
        const r = await getSupabaseAdmin().rpc(write ? 'veo_demographic_action' : 'veo_demographic_access', write ? { ...args, p_action: body.action, p_fields: body.fields || {} } : args);
        if (r.error) return NextResponse.json({ error: r.error.code === '42501' ? 'Contact access denied' : 'Demographic data is temporarily unavailable' }, { status: r.error.code === '42501' ? 403 : 503 });
        return NextResponse.json({ ...r.data, fields: recordedDemographics(r.data) }, { status: write && body.action === 'refresh' ? 202 : 200, headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) { return NextResponse.json({ error: e.message || 'Demographic data unavailable' }, { status: 400 }); }
}
export const GET = (r: NextRequest) => handle(r, false);
export const POST = (r: NextRequest) => handle(r, true);
