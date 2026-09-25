import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { userHasPageAccess } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
    CONTACT_PIPELINE_LABELS,
    CONTACT_PIPELINE_STAGES,
    isContactPipelineStage,
    updateContactPipelineStage
} from '@/lib/contact-pipeline';

export const dynamic = 'force-dynamic';

async function authorize(request: NextRequest, pageId: string) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!await userHasPageAccess(session.user.id, pageId)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return null;
}

function positiveInteger(value: string | null, fallback: number, max: number) {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorizationError = await authorize(request, pageId);
        if (authorizationError) return authorizationError;

        const searchParams = new URL(request.url).searchParams;
        const page = positiveInteger(searchParams.get('page'), 1, 100000);
        const pageSize = positiveInteger(searchParams.get('pageSize'), 25, 100);
        const requestedStage = searchParams.get('stage');
        const stage = isContactPipelineStage(requestedStage) ? requestedStage : null;
        const search = (searchParams.get('search') || '')
            .trim()
            .replace(/[^\p{L}\p{N}\s@._+-]/gu, ' ')
            .slice(0, 100);
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        const db = getSupabaseAdmin();

        let contactsQuery = db
            .from('contacts')
            .select(
                'id,page_id,psid,name,profile_pic,last_interaction_at,last_inbound_at,created_at,pipeline_stage,pipeline_stage_source,pipeline_stage_updated_at',
                search ? { count: 'exact' } : {}
            )
            .eq('page_id', pageId)
            .order('pipeline_stage_updated_at', { ascending: false })
            .order('last_interaction_at', { ascending: false, nullsFirst: false });
        if (stage) contactsQuery = contactsQuery.eq('pipeline_stage', stage);
        if (search) contactsQuery = contactsQuery.or(`name.ilike.*${search}*,psid.ilike.*${search}*`);

        const [contactsResult, stageCountResult] = await Promise.all([
            contactsQuery.range(from, to),
            db.rpc('get_contact_pipeline_counts', { p_page_id: pageId })
        ]);
        if (contactsResult.error) throw contactsResult.error;
        if (stageCountResult.error) throw stageCountResult.error;

        const contacts = contactsResult.data || [];
        const contactIds = contacts.map((contact) => contact.id);
        const { data: chatbotStates, error: stateError } = contactIds.length > 0
            ? await db
                .from('chatbot_contact_states')
                .select('contact_id,status,collected_details,missing_details,stop_reason,last_inbound_at,last_bot_reply_at,updated_at')
                .eq('page_id', pageId)
                .in('contact_id', contactIds)
            : { data: [], error: null };
        if (stateError) throw stateError;
        const stateByContactId = new Map((chatbotStates || []).map((state) => [state.contact_id, state]));

        const returnedCounts = stageCountResult.data && typeof stageCountResult.data === 'object'
            ? stageCountResult.data as Record<string, unknown>
            : {};
        const stageCounts = Object.fromEntries(CONTACT_PIPELINE_STAGES.map((pipelineStage) => [
            pipelineStage,
            Math.max(0, Number(returnedCounts[pipelineStage]) || 0)
        ]));
        const totalForView = search
            ? contactsResult.count || 0
            : stage
                ? stageCounts[stage]
                : Object.values(stageCounts).reduce((sum, count) => sum + count, 0);

        return NextResponse.json({
            contacts: contacts.map((contact) => ({
                ...contact,
                chatbot_state: stateByContactId.get(contact.id) || null
            })),
            page,
            pageSize,
            total: totalForView,
            stageCounts,
            stages: CONTACT_PIPELINE_STAGES.map((value) => ({ value, label: CONTACT_PIPELINE_LABELS[value] }))
        });
    } catch (error) {
        console.error('[PIPELINE_GET]', error);
        return NextResponse.json(
            { error: 'Failed to load contact pipeline', message: (error as Error).message },
            { status: 500 }
        );
    }
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorizationError = await authorize(request, pageId);
        if (authorizationError) return authorizationError;
        const body = await request.json();
        const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : '';
        if (!contactId || !isContactPipelineStage(body.stage)) {
            return NextResponse.json({ error: 'A valid contact and pipeline stage are required' }, { status: 400 });
        }

        const db = getSupabaseAdmin();
        const { data: contact, error: contactError } = await db
            .from('contacts')
            .select('id')
            .eq('id', contactId)
            .eq('page_id', pageId)
            .maybeSingle();
        if (contactError) throw contactError;
        if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

        await updateContactPipelineStage(db, {
            pageId,
            contactId,
            stage: body.stage,
            source: 'manual',
            force: true
        });
        return NextResponse.json({ success: true, stage: body.stage });
    } catch (error) {
        console.error('[PIPELINE_PATCH]', error);
        return NextResponse.json(
            { error: 'Failed to update pipeline stage', message: (error as Error).message },
            { status: 500 }
        );
    }
}
