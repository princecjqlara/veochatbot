import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { userHasPageAccess } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';
import { HUMAN_AGENT_REPLY_WINDOW_MS } from '@/lib/human-agent-window';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) {
            return NextResponse.json({ message: 'Please sign in.' }, { status: 401 });
        }
        const { pageId } = await params;
        if (!await userHasPageAccess(session.user.id, pageId)) {
            return NextResponse.json({ message: 'You do not have access to this page.' }, { status: 403 });
        }

        const db = getSupabaseAdmin();
        const { data, error } = await db.from('chatbot_follow_up_jobs')
            .select('id,contact_id,anchor_inbound_at,due_at,message_text,media_asset_id,contacts!inner(id,page_id,psid,name,profile_pic,last_interaction_at,last_inbound_at,first_interaction_at,created_at,updated_at,best_contact_hour,best_contact_hours,best_contact_confidence),chatbot_media_assets(id,title,media_type)')
            .eq('page_id', pageId)
            .eq('schedule_type', 'manual_human_agent')
            .eq('status', 'ready_manual')
            .order('due_at', { ascending: true })
            .limit(100);
        if (error) throw error;

        const now = Date.now();
        const jobs = (data || []).flatMap((row: Record<string, any>) => {
            const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts;
            const lastInboundAt = contact?.last_inbound_at;
            const lastInboundTime = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
            const anchorTime = Date.parse(row.anchor_inbound_at);
            if (!contact || !Number.isFinite(lastInboundTime) || !Number.isFinite(anchorTime)) return [];
            if (lastInboundTime > anchorTime || now - lastInboundTime >= HUMAN_AGENT_REPLY_WINDOW_MS - 60_000) return [];
            return [{
                id: row.id,
                due_at: row.due_at,
                message_text: row.message_text,
                media: Array.isArray(row.chatbot_media_assets)
                    ? row.chatbot_media_assets[0] || null
                    : row.chatbot_media_assets || null,
                contact
            }];
        });

        return NextResponse.json({ jobs });
    } catch (error) {
        console.error('[CHATBOT_HUMAN_AGENT_DRAFTS_GET]', error);
        return NextResponse.json(
            { message: 'Could not load chatbot Human Agent drafts.' },
            { status: 500 }
        );
    }
}
