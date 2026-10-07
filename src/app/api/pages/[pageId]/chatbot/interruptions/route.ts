import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { userHasPageAccess } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type InterruptionRow = {
    id: string;
    contact_id: string;
    actor_name: string | null;
    source: 'veobot' | 'business_suite';
    interruption_type: 'manual_message' | 'lead_stage_change';
    lead_stage: string | null;
    collected_detail_count: number;
    required_detail_count: number;
    interrupted_at: string;
};

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

        const db = getSupabaseAdmin();
        const { data, error } = await db
            .from('chatbot_interruption_events')
            .select('id, contact_id, actor_name, source, interruption_type, lead_stage, collected_detail_count, required_detail_count, interrupted_at')
            .eq('page_id', pageId)
            .order('interrupted_at', { ascending: false })
            .limit(100);
        if (error) throw error;

        const rows = (data || []) as InterruptionRow[];
        const contactIds = [...new Set(rows.map((row) => row.contact_id))];
        const contactNames = new Map<string, string | null>();
        if (contactIds.length > 0) {
            const { data: contacts, error: contactsError } = await db
                .from('contacts')
                .select('id, name')
                .eq('page_id', pageId)
                .in('id', contactIds);
            if (contactsError) throw contactsError;
            for (const contact of contacts || []) {
                contactNames.set(contact.id, contact.name || null);
            }
        }

        return NextResponse.json({
            interruptions: rows.map((row) => ({
                id: row.id,
                sent_by: row.actor_name || (row.source === 'business_suite'
                    ? 'Business Suite team member'
                    : 'VeoBot team member'),
                contact_name: contactNames.get(row.contact_id) || 'Messenger contact',
                interruption_type: row.interruption_type,
                lead_stage: row.lead_stage,
                collected_detail_count: row.collected_detail_count,
                required_detail_count: row.required_detail_count,
                interrupted_at: row.interrupted_at
            }))
        });
    } catch (error) {
        console.error('[CHATBOT_INTERRUPTION_LIST]', error);
        return NextResponse.json(
            { error: 'Failed to load bot interruptions', message: (error as Error).message },
            { status: 500 }
        );
    }
}
