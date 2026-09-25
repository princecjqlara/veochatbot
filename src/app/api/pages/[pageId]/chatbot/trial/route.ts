import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { userHasPageAccess } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';

async function authorize(request: NextRequest, pageId: string) {
    const session = await getSessionFromRequest(request);
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!await userHasPageAccess(userId, pageId)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return null;
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorizationError = await authorize(request, pageId);
        if (authorizationError) return authorizationError;

        const supabase = getSupabaseAdmin();
        const { data: config, error: configError } = await supabase
            .from('chatbot_configs')
            .select('enabled, trial_mode_enabled, trial_contact_id')
            .eq('page_id', pageId)
            .maybeSingle();
        if (configError) throw configError;

        let contact = null;
        let state = null;
        let pendingFollowUps = 0;
        if (config?.trial_contact_id) {
            const [contactResult, stateResult, followUpResult] = await Promise.all([
                supabase
                    .from('contacts')
                    .select('id, name, psid, pipeline_stage, last_interaction_at, last_inbound_at')
                    .eq('page_id', pageId)
                    .eq('id', config.trial_contact_id)
                    .maybeSingle(),
                supabase
                    .from('chatbot_contact_states')
                    .select('status, collected_details, missing_details, stop_reason, started_at, window_expires_at, last_inbound_at, last_bot_reply_at')
                    .eq('page_id', pageId)
                    .eq('contact_id', config.trial_contact_id)
                    .maybeSingle(),
                supabase
                    .from('chatbot_follow_up_jobs')
                    .select('id', { count: 'exact', head: true })
                    .eq('page_id', pageId)
                    .eq('contact_id', config.trial_contact_id)
                    .in('status', ['pending', 'processing', 'ready_manual'])
            ]);
            if (contactResult.error) throw contactResult.error;
            if (stateResult.error) throw stateResult.error;
            if (followUpResult.error) throw followUpResult.error;
            contact = contactResult.data;
            state = stateResult.data;
            pendingFollowUps = followUpResult.count || 0;
        }

        return NextResponse.json({
            trial: {
                enabled: config?.enabled === true && config?.trial_mode_enabled === true,
                chatbot_enabled: config?.enabled === true,
                trial_mode_enabled: config?.trial_mode_enabled === true,
                contact,
                state,
                pending_follow_ups: pendingFollowUps
            }
        });
    } catch (error) {
        console.error('[CHATBOT_TRIAL_GET]', error);
        return NextResponse.json(
            { error: 'Failed to load live trial status', message: (error as Error).message },
            { status: 500 }
        );
    }
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorizationError = await authorize(request, pageId);
        if (authorizationError) return authorizationError;

        const body = await request.json();
        const action = body.action === 'configure' || body.action === 'reset' ? body.action : '';
        const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : '';
        if (!action || !contactId) {
            return NextResponse.json({ error: 'A valid trial action and contact are required' }, { status: 400 });
        }

        const supabase = getSupabaseAdmin();
        const { data: contact, error: contactError } = await supabase
            .from('contacts')
            .select('id, name, psid')
            .eq('page_id', pageId)
            .eq('id', contactId)
            .maybeSingle();
        if (contactError) throw contactError;
        if (!contact?.id) {
            return NextResponse.json({ error: 'Trial contact was not found on this Page' }, { status: 404 });
        }
        if (action === 'configure') {
            const enabled = body.enabled === true;
            if (enabled && !contact.psid) {
                return NextResponse.json({ error: 'The selected contact cannot receive Messenger messages' }, { status: 400 });
            }
            const { data: config, error: configError } = await supabase
                .from('chatbot_configs')
                .upsert({
                    page_id: pageId,
                    enabled,
                    trial_mode_enabled: enabled,
                    trial_contact_id: contactId,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'page_id' })
                .select('page_id, enabled, trial_mode_enabled, trial_contact_id')
                .single();
            if (configError) throw configError;
            return NextResponse.json({
                success: true,
                config,
                message: enabled
                    ? `Live trial is now restricted to ${contact.name || 'the selected contact'}.`
                    : 'Live trial stopped and the chatbot was disabled.'
            });
        }

        const now = new Date().toISOString();
        const [stateResult, followUpResult, pipelineResult] = await Promise.all([
            supabase
                .from('chatbot_contact_states')
                .delete()
                .eq('page_id', pageId)
                .eq('contact_id', contactId),
            supabase
                .from('chatbot_follow_up_jobs')
                .update({
                    status: 'cancelled',
                    claimed_at: null,
                    cancelled_at: now,
                    error_message: 'Reset from live Messenger trial controls',
                    updated_at: now
                })
                .eq('page_id', pageId)
                .eq('contact_id', contactId)
                .in('status', ['pending', 'processing', 'ready_manual']),
            supabase
                .from('contacts')
                .update({
                    pipeline_stage: 'engaged',
                    pipeline_stage_source: 'manual',
                    pipeline_stage_updated_at: now
                })
                .eq('page_id', pageId)
                .eq('id', contactId)
        ]);
        if (stateResult.error) throw stateResult.error;
        if (followUpResult.error) throw followUpResult.error;
        if (pipelineResult.error) throw pipelineResult.error;

        return NextResponse.json({
            success: true,
            message: `${contact.name || 'The selected contact'} is ready for a fresh chatbot trial.`,
            contact_id: contactId
        });
    } catch (error) {
        console.error('[CHATBOT_TRIAL_POST]', error);
        return NextResponse.json(
            { error: 'Failed to reset the live trial contact', message: (error as Error).message },
            { status: 500 }
        );
    }
}
