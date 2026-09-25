import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { userHasPageAccess } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const ALLOWED_RANGES = new Set([1, 7, 30, 90]);

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (!await userHasPageAccess(session.user.id, pageId)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const requestedDays = Number.parseInt(new URL(request.url).searchParams.get('days') || '7', 10);
        const days = ALLOWED_RANGES.has(requestedDays) ? requestedDays : 7;
        const to = new Date();
        const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
        const db = getSupabaseAdmin();
        const parameters = {
            p_page_id: pageId,
            p_from: from.toISOString(),
            p_to: to.toISOString()
        };
        const [contactResult, pipelineResult, activityResult] = await Promise.all([
            db.rpc('get_chatbot_contact_metrics', parameters),
            db.rpc('get_contact_pipeline_counts', { p_page_id: pageId }),
            db.rpc('get_chatbot_activity_analytics', parameters)
        ]);
        if (contactResult.error) throw contactResult.error;
        if (pipelineResult.error) throw pipelineResult.error;
        if (activityResult.error) throw activityResult.error;

        return NextResponse.json({
            analytics: {
                ...activityResult.data,
                contacts: contactResult.data,
                pipeline: pipelineResult.data
            },
            days
        });
    } catch (error) {
        console.error('[CHATBOT_ANALYTICS_GET]', error);
        return NextResponse.json(
            { error: 'Failed to load chatbot analytics', message: (error as Error).message },
            { status: 500 }
        );
    }
}
