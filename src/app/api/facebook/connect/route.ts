import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { subscribePageToAppWebhook, getPageTemplates, createUtilityTemplate } from '@/lib/facebook';
import { UTILITY_TEMPLATES } from '@/lib/facebook-templates';
import type { UtilityTemplate } from '@/lib/facebook';
import { isFacebookReauthRequired } from '@/lib/facebook';
import { DatabaseReadTimeout, requestDeadline } from '@/lib/request-deadline';
import { FacebookPageConnectionError, verifyFacebookPageConnection, facebookWebhookConnectionStatus } from '@/lib/facebook-page-connection';
import { isApprovedVeoPage } from '@/lib/veo-page-scope';

export const dynamic = 'force-dynamic';
export const maxDuration = 90;

type WebhookRefreshWarning = {
    code: 'WEBHOOK_SUBSCRIPTION_FAILED';
    message: string;
};

// POST /api/facebook/connect - Connect a Facebook page
export async function POST(request: NextRequest) {
    try {
        const session = await requestDeadline(() => getSessionFromRequest(request), 10000);

        if (!session) {
            console.error('🔴 No session found in /api/facebook/connect');
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const userId = session.user?.id;
        if (!userId) {
            console.error('🔴 No user ID in session:', session.user);
            return NextResponse.json(
                { error: 'Unauthorized', message: 'User not found. Please sign in again.' },
                { status: 401 }
            );
        }

        console.log('🔵 Session found:', { 
            email: session.user?.email, 
            userId 
        });

        let body;
        try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request', message: 'Choose a Page and retry Connect.' }, { status: 400 }); }
        const { fbPageId, name, accessToken } = body || {};

        if (typeof fbPageId !== 'string' || !/^\d{1,100}$/.test(fbPageId) || typeof name !== 'string' || !name.trim() || name.length > 500 ||
            typeof accessToken !== 'string' || !accessToken.trim() || accessToken.length > 8192) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Missing required fields: fbPageId, name, accessToken' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Check if page already exists
        const { data: existingPage, error: lookupError } = await requestDeadline(signal => supabase
            .from('pages')
            .select('id')
            .eq('fb_page_id', fbPageId)
            .abortSignal(signal).maybeSingle(), 10000);
        if (lookupError) throw lookupError;
        const verified = await verifyFacebookPageConnection(fbPageId, accessToken);
        if(process.env.VEO_PAGE_SCOPE_ENFORCED==='true'&&!isApprovedVeoPage(fbPageId,verified.name||''))return NextResponse.json({success:false,error:'Page outside VeoBot scope',message:'Choose one of the 15 VeoBot Pages configured for this workspace.'},{status:403});

        let pageId: string;

        if (existingPage) {
            // Update existing page with new access token
            const { data: updatedPage, error: updateError } = await requestDeadline(signal => supabase
                .from('pages')
                .update({
                    access_token: accessToken,
                    name: verified.name || name.trim(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', existingPage.id).select('id').abortSignal(signal).single(), 10000);

            if (updateError) throw updateError;
            if (!updatedPage?.id) throw new Error('Page token update did not return a saved Page');
            pageId = updatedPage.id;
        } else {
            // Create new page
            const { data: newPage, error: pageError } = await requestDeadline(signal => supabase
                .from('pages')
                .upsert({
                    fb_page_id: fbPageId,
                    name: verified.name || name.trim(),
                    access_token: accessToken
                }, { onConflict: 'fb_page_id' })
                .select('id')
                .abortSignal(signal).single(), 10000);

            if (pageError) throw pageError;
            if (!newPage?.id) throw new Error('Page connection did not return a saved Page');
            pageId = newPage.id;
        }

        // Link user to page
        const { data: linkedPage, error: linkError } = await requestDeadline(signal => supabase
            .from('user_pages')
            .upsert({
                user_id: userId,
                page_id: pageId
            }, {
                onConflict: 'user_id,page_id'
            }).select('page_id').abortSignal(signal).single(), 10000);

        if (linkError) throw linkError;
        if (linkedPage?.page_id !== pageId) throw new Error('Page membership could not be verified after saving');

        let warning: WebhookRefreshWarning | null = null;
        try {
            await requestDeadline(signal => subscribePageToAppWebhook(fbPageId, accessToken, ['messages', 'messaging_postbacks', 'message_echoes'], signal), 8000);
        } catch (subscriptionError) {
            console.error('[PAGE_CONNECT] Webhook subscription unavailable', { pageId, requiresReauth: isFacebookReauthRequired(subscriptionError) });
            warning = {
                code: 'WEBHOOK_SUBSCRIPTION_FAILED',
                message: isFacebookReauthRequired(subscriptionError)
                    ? 'Page access was saved, but Facebook requires renewed permissions to enable live message updates. Use Refresh Permissions, then Reconnect.'
                    : 'Page access was saved, but live message updates could not be enabled. Retry Reconnect to finish setup.'
            };
            return NextResponse.json({ success: false, saved: true, pageId, warning, code: warning.code,
                requiresReauth: isFacebookReauthRequired(subscriptionError), retryable: !isFacebookReauthRequired(subscriptionError), message: warning.message },
                { status: 409, headers: { 'Cache-Control': 'no-store' } });
        }

        if(process.env.VEO_ENFORCE_PAGE_RUNTIME_SCOPE==='true'){
            const ownership=await facebookWebhookConnectionStatus(fbPageId,accessToken,process.env.FACEBOOK_CLIENT_ID);
            if(ownership==='unknown')return NextResponse.json({success:false,saved:true,pageId,code:'FACEBOOK_UNAVAILABLE',retryable:true,message:'Facebook could not confirm the Page connection. Retry Reconnect shortly.'},{status:503});
            if(ownership!=='ready')return NextResponse.json({success:false,saved:true,pageId,code:'FACEBOOK_REAUTH_REQUIRED',requiresReauth:true,message:'Refresh Permissions using the VeoBot Facebook login, then reconnect this Page.'},{status:409});
            const registered=await requestDeadline(()=>supabase.rpc('register_automation_page_owner',{p_page_id:pageId,p_app_id:process.env.FACEBOOK_CLIENT_ID}),8000);
            if(registered.error||registered.data!==true)throw new Error('Page automation ownership could not be saved after connection');
        }
        // Fire-and-forget: auto-submit all UTILITY_TEMPLATES to the newly connected page
        autoSubmitTemplates(fbPageId, accessToken, name).catch((err) =>
            console.error(`[AUTO_SUBMIT] Background template submission failed for page "${name}":`, err)
        );

        return NextResponse.json({
            success: true,
            pageId,
            warning,
            webhookSubscribed: true,
            message: 'Page connected successfully'
        }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        if (error instanceof FacebookPageConnectionError) return NextResponse.json({ success: false, error: 'Page connection incomplete', message: error.message, code: error.code, requiresReauth: error.requiresReauth, retryable: error.retryable }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
        if (error instanceof DatabaseReadTimeout || ['PGRST000', 'PGRST001', 'PGRST002', '57014'].includes(String((error as any)?.code)) || /fetch failed|network|timeout/i.test((error as any)?.message || ''))
            return NextResponse.json({ success: false, error: 'Database unavailable', message: 'The database is not responding, so this Page connection could not be completed. Please retry shortly.', code: 'DATABASE_UNAVAILABLE', retryable: true }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        console.error('[PAGE_CONNECT] Save failed', { code: (error as any)?.code || 'UNKNOWN' });
        return NextResponse.json(
            { success: false, error: 'Failed to connect page', message: 'The Page connection could not be saved. Please retry.' },
            { status: 500 }
        );
    }
}

// ---------------------------------------------------------------------------
//  Auto-submit all UTILITY_TEMPLATES to a Facebook page (background task)
//  Skips templates that already exist on the page.
// ---------------------------------------------------------------------------
async function autoSubmitTemplates(fbPageId: string, accessToken: string, pageName: string) {
    console.log(`[AUTO_SUBMIT] Starting template submission for page "${pageName}" (${fbPageId})...`);

    let existingNames: Set<string>;
    try {
        const existingTemplates = await getPageTemplates(fbPageId, accessToken);
        existingNames = new Set(
            existingTemplates
                .filter((t: Record<string, unknown>) => typeof t.name === 'string')
                .map((t: Record<string, unknown>) => t.name as string)
        );
    } catch (err) {
        console.warn(`[AUTO_SUBMIT] Could not fetch existing templates for "${pageName}":`, (err as Error).message);
        existingNames = new Set();
    }

    let submitted = 0;
    let skipped = 0;
    let failed = 0;

    for (const template of UTILITY_TEMPLATES) {
        if (existingNames.has(template.name)) {
            skipped++;
            continue;
        }

        try {
            const { paramCount: _pc, ...templateFields } = template as any;
            const fullTemplate: UtilityTemplate = { ...templateFields, language: 'en_US' };
            await createUtilityTemplate(fbPageId, accessToken, fullTemplate);
            submitted++;
        } catch (err) {
            const msg = (err as Error).message || '';
            if (msg.includes('2018423') || msg.includes('already exists')) {
                skipped++;
            } else {
                failed++;
                console.warn(`[AUTO_SUBMIT] Template "${template.name}" failed for "${pageName}":`, msg);
            }
        }
    }

    console.log(
        `[AUTO_SUBMIT] Done for "${pageName}": ${submitted} submitted, ${skipped} already existed, ${failed} failed`
    );
}
