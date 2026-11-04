import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { authorizeContactProfile } from '@/lib/contact-profile-access';
import { gunzipSync } from 'node:zlib';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ pageId: string; contactId: string }> }) {
    const scope = await authorizeContactProfile(request, params);
    if ('error' in scope) return scope.error;
    try {
        const db = getSupabaseAdmin();
        const snapshot = await db.from('contact_profile_snapshots').select('generation,source_cutoff_at,payload').eq('page_id', scope.pageId).eq('contact_id', scope.contactId).order('generation', { ascending: false }).limit(1).maybeSingle();
        if (snapshot.error) throw new Error('Could not load message source');
        if (!snapshot.data) return NextResponse.json({ items: [], total: 0, generation: null });
        const page = Math.max(1, Math.min(10000, Number.parseInt(request.nextUrl.searchParams.get('page') || '1', 10) || 1));
        const id = request.nextUrl.searchParams.get('messageId');
        const archive = await db.from('contact_profile_transcripts')
            .select('source_cutoff_at,source_sha256,message_count,attachment_count,image_count,messages_gzip_base64')
            .eq('page_id', scope.pageId).eq('contact_id', scope.contactId).eq('snapshot_generation', snapshot.data.generation).maybeSingle();
        if (archive.error) throw new Error('Could not load archived conversation');
        if (archive.data && Date.parse(archive.data.source_cutoff_at) >= Date.parse(snapshot.data.source_cutoff_at)) {
            const messages = JSON.parse(gunzipSync(Buffer.from(archive.data.messages_gzip_base64, 'base64')).toString('utf8'));
            if (!Array.isArray(messages) || messages.length !== archive.data.message_count) throw new Error('Archived conversation is incomplete');
            const ordered = messages.slice().sort((a: any, b: any) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
            const filtered = id ? ordered.filter((message: any) => message.id === id) : ordered.slice((page - 1) * 50, page * 50);
            if (!id || filtered.length) return NextResponse.json({ items: filtered.map((message: any) => ({
                message_id: message.id, sent_at: message.at, sender: message.sender, text: message.text,
                attachment_count: message.attachments || 0, image_count: message.images || 0
            })), total: id ? filtered.length : messages.length, generation: snapshot.data.generation,
                storage: 'complete_archive', archived_at: archive.data.source_cutoff_at,
                attachment_count: archive.data.attachment_count, image_count: archive.data.image_count },
                { headers: { 'Cache-Control': 'no-store' } });
        }
        let query = db.from('contact_profile_messages').select('message_id,sent_at,sender,text,attachment_count', { count: 'exact' })
            .eq('page_id', scope.pageId).eq('contact_id', scope.contactId).eq('generation', snapshot.data.generation);
        if (id) query = query.eq('message_id', id);
        const result = await query.order('sent_at', { ascending: false }).order('message_id', { ascending: false }).range((page - 1) * 50, page * 50 - 1);
        if (result.error) throw new Error('Could not load conversation');
        return NextResponse.json({ items: result.data || [], total: result.count || 0, generation: snapshot.data.generation }, { headers: { 'Cache-Control': 'no-store' } });
    } catch { return NextResponse.json({ error: 'Conversation messages are temporarily unavailable' }, { status: 503 }); }
}
