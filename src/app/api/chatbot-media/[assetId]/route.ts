import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { createChatbotMediaSignedUrl, type ChatbotMediaAsset } from '@/lib/chatbot-media';
import { validMediaToken } from '@/lib/veo-media-token';

export const dynamic = 'force-dynamic';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ assetId: string }> }
) {
    const { assetId } = await params;
    if (!UUID_PATTERN.test(assetId)) {
        return NextResponse.json({ error: 'Media not found' }, { status: 404 });
    }
    if (process.env.VEO_WORKSPACE_ENABLED === 'true' && request.nextUrl.searchParams.has('token') && !validMediaToken(assetId, request.nextUrl.searchParams.get('expires'), request.nextUrl.searchParams.get('token'))) return NextResponse.json({ error: 'Media access expired' }, { status: 403 });

    const { data, error } = await getSupabaseAdmin()
        .from('chatbot_media_assets')
        .select('storage_bucket, storage_path, page_id')
        .eq('id', assetId)
        .eq('status', 'ready')
        .maybeSingle();
    if (error || !data) {
        return NextResponse.json({ error: 'Media not found' }, { status: 404 });
    }
    if (process.env.VEO_WORKSPACE_ENABLED === 'true') {
        const active = await getSupabaseAdmin().rpc('veo_active_pages');
        if (active.error || !active.data?.includes(data.page_id)) return NextResponse.json({ error: 'Media unavailable' }, { status: 403 });
    }

    try {
        const signedUrl = await createChatbotMediaSignedUrl(data as Pick<ChatbotMediaAsset, 'storage_bucket' | 'storage_path'>);
        const response = NextResponse.redirect(signedUrl, 307);
        response.headers.set('Cache-Control', 'no-store, max-age=0');
        return response;
    } catch {
        return NextResponse.json({ error: 'Media is temporarily unavailable' }, { status: 503 });
    }
}
