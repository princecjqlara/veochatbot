import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { sendUtilityMessage } from '@/lib/facebook';
import { recordOutboundMessageEvent } from '@/lib/outbound-message-events';
import { stopChatbotForManualReply } from '@/lib/chatbot-handoff';

export async function POST(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const body = await request.json();
        const { pageId, recipientPsid, templateName, language = 'en_US', messageText } = body;

        if (!pageId || !recipientPsid || !templateName || !messageText) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'pageId, recipientPsid, templateName, and messageText are required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        const { data: userPage, error: userPageError } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (userPageError || !userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        const { data: page, error: pageError } = await supabase
            .from('pages')
            .select('fb_page_id, access_token')
            .eq('id', pageId)
            .single();

        if (pageError || !page) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        let { data: contact, error: contactError } = await supabase
            .from('contacts').select('id').eq('page_id', pageId).eq('psid', recipientPsid).maybeSingle();
        if (contactError) throw contactError;
        if (!contact) {
            const inserted = await supabase.from('contacts')
                .upsert({ page_id: pageId, psid: recipientPsid }, { onConflict: 'page_id,psid', ignoreDuplicates: true })
                .select('id').maybeSingle();
            if (inserted.error) throw inserted.error;
            contact = inserted.data;
            if (!contact) {
                const found = await supabase.from('contacts').select('id')
                    .eq('page_id', pageId).eq('psid', recipientPsid).maybeSingle();
                if (found.error) throw found.error;
                contact = found.data;
            }
            if (!contact) throw new Error('Could not save contact before manual reply');
        }
        const stateBeforeStop = await stopChatbotForManualReply({ supabase, pageId, contactId: contact.id });
        const result = await sendUtilityMessage(
            page.fb_page_id,
            page.access_token,
            recipientPsid,
            templateName,
            language,
            messageText
        );
        await recordOutboundMessageEvent(supabase, {
            pageId,
            contactId: contact?.id || null,
            messageId: result.message_id,
            sourceType: 'manual',
            stateBeforeStop,
            sourceName: 'VeoBot template send',
            actorUserId: session.user.id,
            actorName: session.user.name || session.user.email || null,
            messageKind: `UTILITY (${templateName})`
        });

        return NextResponse.json({
            success: true,
            messageId: result.message_id,
            recipientId: result.recipient_id
        });
    } catch (error) {
        console.error('Error sending utility message:', error);
        return NextResponse.json(
            { error: 'Internal Server Error', message: (error as Error).message },
            { status: 500 }
        );
    }
}
