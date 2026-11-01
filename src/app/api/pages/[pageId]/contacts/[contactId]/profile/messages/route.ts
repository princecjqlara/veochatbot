import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { authorizeContactProfile } from '@/lib/contact-profile-access';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ pageId: string; contactId: string }> }) {
    const scope = await authorizeContactProfile(request, params);
    if ('error' in scope) return scope.error;
    try {
        const db = getSupabaseAdmin();
        const snapshot = await db.from('contact_profile_snapshots').select('generation').eq('page_id', scope.pageId).eq('contact_id', scope.contactId).order('generation', { ascending: false }).limit(1).maybeSingle();
        if (snapshot.error) throw new Error('Could not load message source');
        if (!snapshot.data) return NextResponse.json({ items: [], total: 0, generation: null });
        const page = Math.max(1, Math.min(10000, Number.parseInt(request.nextUrl.searchParams.get('page') || '1', 10) || 1));
        const id = request.nextUrl.searchParams.get('messageId');
        let query = db.from('contact_profile_messages').select('message_id,sent_at,sender,text,attachment_count', { count: 'exact' })
            .eq('page_id', scope.pageId).eq('contact_id', scope.contactId).eq('generation', snapshot.data.generation);
        if (id) query = query.eq('message_id', id);
        const result = await query.order('sent_at', { ascending: false }).order('message_id', { ascending: false }).range((page - 1) * 50, page * 50 - 1);
        if (result.error) throw new Error('Could not load conversation');
        return NextResponse.json({ items: result.data || [], total: result.count || 0, generation: snapshot.data.generation }, { headers: { 'Cache-Control': 'no-store' } });
    } catch { return NextResponse.json({ error: 'Conversation messages are temporarily unavailable' }, { status: 503 }); }
}
