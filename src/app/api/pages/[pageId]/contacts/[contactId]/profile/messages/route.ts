import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { authorizeContactProfile } from '@/lib/contact-profile-access';
export const dynamic = 'force-dynamic';

type CitedSource = { message_id: string; quote: string; sent_at?: string; sender?: 'customer' | 'page' | 'unknown' };

function citedSources(payload: Record<string, any>): CitedSource[] {
    const byId = new Map<string, CitedSource>();
    const visit = (value: unknown) => {
        if (Array.isArray(value)) { for (const item of value) visit(item); return; }
        if (!value || typeof value !== 'object') return;
        const item = value as Record<string, unknown>;
        if (typeof item.message_id === 'string' && typeof item.quote === 'string' && item.quote.trim()) {
            const previous = byId.get(item.message_id);
            byId.set(item.message_id, { message_id: item.message_id, quote: item.quote.slice(0, 1000),
                sent_at: typeof item.at === 'string' ? item.at : previous?.sent_at,
                sender: item.sender === 'customer' || item.sender === 'page' || item.sender === 'unknown' ? item.sender : previous?.sender });
        }
        for (const child of Object.values(item)) visit(child);
    };
    visit(payload);
    return [...byId.values()].sort((a, b) => (b.sent_at ? Date.parse(b.sent_at) : 0) - (a.sent_at ? Date.parse(a.sent_at) : 0) || a.message_id.localeCompare(b.message_id));
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ pageId: string; contactId: string }> }) {
    const scope = await authorizeContactProfile(request, params);
    if ('error' in scope) return scope.error;
    try {
        const db = getSupabaseAdmin();
        const snapshot = await db.from('contact_profile_snapshots').select('generation,source_cutoff_at,payload')
            .eq('page_id', scope.pageId).eq('contact_id', scope.contactId).order('generation', { ascending: false }).limit(1).maybeSingle();
        if (snapshot.error) throw new Error('Could not load saved profile evidence');
        if (!snapshot.data) return NextResponse.json({ items: [], total: 0, generation: null, storage: 'local_archive' });
        const sources = citedSources(snapshot.data.payload || {});
        const page = Math.max(1, Math.min(1000, Number.parseInt(request.nextUrl.searchParams.get('page') || '1', 10) || 1));
        const id = request.nextUrl.searchParams.get('messageId');
        const matching = id ? sources.filter(item => item.message_id === id) : sources.slice((page - 1) * 50, page * 50);
        return NextResponse.json({ items: matching.map(item => ({ message_id: item.message_id, sent_at: item.sent_at || null,
            sender: item.sender || 'unknown', text: item.quote, attachment_count: 0, image_count: 0 })), total: id ? matching.length : sources.length,
            generation: snapshot.data.generation, storage: 'cited_evidence', full_history: 'local_archive' }, { headers: { 'Cache-Control': 'no-store' } });
    } catch { return NextResponse.json({ error: 'Saved profile evidence is temporarily unavailable' }, { status: 503 }); }
}
