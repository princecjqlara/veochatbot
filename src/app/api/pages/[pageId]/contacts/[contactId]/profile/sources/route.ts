import { NextRequest, NextResponse } from 'next/server';
import { authorizeContactProfile } from '@/lib/contact-profile-access';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getContactSources } from '@/lib/contact-profile-sources';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ pageId: string; contactId: string }> }) {
    const scope = await authorizeContactProfile(request, params);
    if ('error' in scope) return scope.error;
    const eventKey = request.nextUrl.searchParams.get('eventKey') || undefined;
    if (eventKey && !/^[a-zA-Z0-9:_-]{1,200}$/.test(eventKey)) return NextResponse.json({ error: 'Invalid source reference' }, { status: 400 });
    try {
        const result = await getContactSources(getSupabaseAdmin(), scope.pageId, scope.contactId, {
            page: Number.parseInt(request.nextUrl.searchParams.get('page') || '1', 10) || 1, eventKey
        });
        return result ? NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } }) : NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    } catch { return NextResponse.json({ error: 'Recorded ad sources are temporarily unavailable' }, { status: 503 }); }
}
