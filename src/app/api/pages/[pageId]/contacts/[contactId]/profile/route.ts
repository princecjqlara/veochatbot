import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { authorizeContactProfile } from '@/lib/contact-profile-access';
import { getContactProfile } from '@/lib/contact-profile-service';
import { processContactProfiles } from '@/lib/contact-profile-worker';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest, { params }: { params: Promise<{ pageId: string; contactId: string }> }) {
    const scope = await authorizeContactProfile(request, params);
    if ('error' in scope) return scope.error;
    try {
        const profile = await getContactProfile(getSupabaseAdmin(), scope.pageId, scope.contactId);
        return profile ? NextResponse.json(profile, { headers: { 'Cache-Control': 'no-store' } }) : NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    } catch { return NextResponse.json({ error: 'Contact profile is temporarily unavailable' }, { status: 503 }); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ pageId: string; contactId: string }> }) {
    const scope = await authorizeContactProfile(request, params, true);
    if ('error' in scope) return scope.error;
    try {
        const body = await request.json();
        const db = getSupabaseAdmin();
        const { error } = await db.rpc('enqueue_contact_profile', { p_page_id: scope.pageId, p_contact_id: scope.contactId, p_reason: body.force === true ? 'manual_refresh' : 'profile_open' });
        if (error) throw new Error('Could not queue profile analysis');
        const result = await processContactProfiles({ contactId: scope.contactId, limit: 1, budgetMs: 70000 });
        return NextResponse.json(result, { status: 202, headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not refresh profile' }, { status: 503 }); }
}
