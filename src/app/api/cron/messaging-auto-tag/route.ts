import { NextRequest, NextResponse } from 'next/server';
import { processOneMessagingAutoTagPage, processMessagingStageSyncBatch } from '@/lib/messaging-auto-tag-worker';
import { isSupabaseUnavailable } from '@/lib/supabase-errors';
import { processVeoAutoTags } from '@/lib/veo-autotag';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (!secret) return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
    if (request.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
        if (process.env.VEO_WORKSPACE_ENABLED === 'true') {
            const result = await processVeoAutoTags();
            return NextResponse.json({ success: result.failed === 0, ...result }, { status: result.failed ? 503 : 200, headers: { 'Cache-Control': 'no-store' } });
        }
        const params = new URL(request.url).searchParams;
        const pageId = params.get('pageId') || undefined;
        const chatbotOnly = params.get('chatbotOnly') === 'true';
        const result = pageId || chatbotOnly
            ? await processOneMessagingAutoTagPage({ pageId, chatbotOnly })
            : await processMessagingStageSyncBatch();
        const success = !('failed' in result && result.failed);
        return NextResponse.json({ success, ...result }, { status: success ? 200 : 503 });
    } catch (error) {
        if (isSupabaseUnavailable(error)) {
            console.warn('[MESSAGING_AUTO_TAG] Supabase unavailable; sync deferred');
            return NextResponse.json({ success: false, error: 'Messaging auto-tag sync temporarily unavailable', retryable: true }, {
                status: 503, headers: { 'Retry-After': '60' }
            });
        }
        console.error('[MESSAGING_AUTO_TAG] Failed:', error);
        return NextResponse.json({ error: 'Messaging auto-tag sync failed' }, { status: 500 });
    }
}
