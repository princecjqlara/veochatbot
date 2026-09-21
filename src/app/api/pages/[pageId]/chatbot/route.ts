import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { userHasPageAccess } from '@/lib/page-access';
import {
    DEFAULT_CHATBOT_FALLBACK,
    DEFAULT_CHATBOT_INSTRUCTIONS,
    DEFAULT_CHATBOT_MODEL,
    generateChatbotReply,
    type ChatbotConfig
} from '@/lib/chatbot';

function defaultConfig(pageId: string): ChatbotConfig {
    return {
        page_id: pageId,
        enabled: false,
        instructions: DEFAULT_CHATBOT_INSTRUCTIONS,
        fallback_reply: DEFAULT_CHATBOT_FALLBACK,
        model: process.env.OPENROUTER_MODEL || DEFAULT_CHATBOT_MODEL
    };
}

async function getAuthorizedPage(request: NextRequest, pageId: string) {
    const session = await getSessionFromRequest(request);
    const userId = session?.user?.id;
    if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    if (!await userHasPageAccess(userId, pageId)) {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    return { userId };
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorization = await getAuthorizedPage(request, pageId);
        if (authorization.error) return authorization.error;

        const { data, error } = await getSupabaseAdmin()
            .from('chatbot_configs')
            .select('page_id, enabled, instructions, fallback_reply, model')
            .eq('page_id', pageId)
            .maybeSingle();

        if (error) throw error;

        return NextResponse.json({
            config: data || defaultConfig(pageId),
            provider: {
                configured: Boolean(process.env.OPENROUTER_API_KEY),
                default_model: process.env.OPENROUTER_MODEL || DEFAULT_CHATBOT_MODEL
            }
        });
    } catch (error) {
        console.error('[CHATBOT_CONFIG_GET]', error);
        return NextResponse.json(
            { error: 'Failed to load chatbot settings', message: (error as Error).message },
            { status: 500 }
        );
    }
}

export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorization = await getAuthorizedPage(request, pageId);
        if (authorization.error) return authorization.error;

        const body = await request.json();
        const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
        const fallbackReply = typeof body.fallback_reply === 'string' ? body.fallback_reply.trim() : '';
        const model = typeof body.model === 'string' ? body.model.trim() : '';

        if (!instructions || instructions.length > 5000) {
            return NextResponse.json({ error: 'Instructions must be between 1 and 5000 characters' }, { status: 400 });
        }
        if (!fallbackReply || fallbackReply.length > 1000) {
            return NextResponse.json({ error: 'Fallback reply must be between 1 and 1000 characters' }, { status: 400 });
        }
        if (!model || model.length > 200) {
            return NextResponse.json({ error: 'Model must be between 1 and 200 characters' }, { status: 400 });
        }
        if (body.enabled === true && !process.env.OPENROUTER_API_KEY) {
            return NextResponse.json({ error: 'OPENROUTER_API_KEY is not configured on the server' }, { status: 400 });
        }

        const { data, error } = await getSupabaseAdmin()
            .from('chatbot_configs')
            .upsert({
                page_id: pageId,
                enabled: body.enabled === true,
                instructions,
                fallback_reply: fallbackReply,
                model,
                updated_at: new Date().toISOString()
            }, { onConflict: 'page_id' })
            .select('page_id, enabled, instructions, fallback_reply, model')
            .single();

        if (error) throw error;
        return NextResponse.json({ config: data });
    } catch (error) {
        console.error('[CHATBOT_CONFIG_PUT]', error);
        return NextResponse.json(
            { error: 'Failed to save chatbot settings', message: (error as Error).message },
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
        const authorization = await getAuthorizedPage(request, pageId);
        if (authorization.error) return authorization.error;

        const body = await request.json();
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message || message.length > 2000) {
            return NextResponse.json({ error: 'Test message must be between 1 and 2000 characters' }, { status: 400 });
        }

        const { data, error } = await getSupabaseAdmin()
            .from('chatbot_configs')
            .select('page_id, enabled, instructions, fallback_reply, model')
            .eq('page_id', pageId)
            .maybeSingle();
        if (error) throw error;

        const config = (data || defaultConfig(pageId)) as ChatbotConfig;
        const reply = await generateChatbotReply({
            config,
            pageId: 'test-page',
            contactName: 'Test Customer',
            inboundMessage: message,
            history: []
        });

        return NextResponse.json({ reply });
    } catch (error) {
        console.error('[CHATBOT_TEST_POST]', error);
        return NextResponse.json(
            { error: 'Chatbot test failed', message: (error as Error).message },
            { status: 502 }
        );
    }
}
