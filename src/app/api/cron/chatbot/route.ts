import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { recoverMissingChatbotMessages } from '@/lib/chatbot-inbound-recovery';
import { processOneMessagingAutoTagPage } from '@/lib/messaging-auto-tag-worker';
import { processChatbotContinuationReviews } from '@/lib/chatbot-continuation';
import { processDueChatbotFollowUps } from '@/lib/chatbot-follow-ups';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Vercel schedules this independently of the external campaign worker. */
export async function GET(request: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (!secret) return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
    if (request.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const results: Record<string, unknown> = {};
    let success = true;
    const run = async (name: string, operation: () => Promise<unknown>) => {
        try {
            const result = await operation();
            results[name] = result;
            if (result && typeof result === 'object' && 'failed' in result && result.failed) success = false;
        } catch (error) {
            success = false;
            results[name] = { failed: true, retryable: true };
            console.error('[CHATBOT_CRON] ' + name + ' failed:', error);
        }
    };
    await run('inboundRecovery', () => recoverMissingChatbotMessages());
    // Refresh staff handoffs before any scheduled continuation or follow-up.
    // Each actual delivery also rechecks the saved and live Messenger guards.
    await run('messagingAutoTag', () => processOneMessagingAutoTagPage({ chatbotOnly: true }));
    await run('intakeReviews', () => processChatbotContinuationReviews({ limit: 2 }));
    await run('chatbotFollowUps', () => processDueChatbotFollowUps({ supabase: getSupabaseAdmin(), limit: 20 }));
    return NextResponse.json({ success, ...results }, { status: success ? 200 : 503 });
}
