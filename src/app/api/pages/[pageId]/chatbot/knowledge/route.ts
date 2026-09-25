import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { userHasPageAccess } from '@/lib/page-access';
import {
    ingestChatbotKnowledge,
    MAX_KNOWLEDGE_CHARACTERS
} from '@/lib/chatbot-knowledge';

async function authorize(request: NextRequest, pageId: string) {
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
        const authorization = await authorize(request, pageId);
        if (authorization.error) return authorization.error;

        const { data, error } = await getSupabaseAdmin()
            .from('chatbot_knowledge_documents')
            .select('id, page_id, title, source_type, original_filename, char_count, chunk_count, status, error_message, created_at, updated_at')
            .eq('page_id', pageId)
            .order('created_at', { ascending: false });
        if (error) throw error;

        return NextResponse.json({ documents: data || [] });
    } catch (error) {
        console.error('[CHATBOT_KNOWLEDGE_GET]', error);
        return NextResponse.json(
            { error: 'Failed to load chatbot knowledge', message: (error as Error).message },
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
        const authorization = await authorize(request, pageId);
        if (authorization.error || !authorization.userId) return authorization.error;

        const body = await request.json();
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const content = typeof body.content === 'string' ? body.content : '';
        const sourceType = body.source_type === 'file' ? 'file' : 'manual';
        const originalFilename = typeof body.original_filename === 'string'
            ? body.original_filename.trim()
            : null;

        if (!title || title.length > 160) {
            return NextResponse.json({ error: 'Title must be between 1 and 160 characters' }, { status: 400 });
        }
        if (content.trim().length < 20 || content.length > MAX_KNOWLEDGE_CHARACTERS) {
            return NextResponse.json(
                { error: `Content must be between 20 and ${MAX_KNOWLEDGE_CHARACTERS.toLocaleString()} characters` },
                { status: 400 }
            );
        }

        const document = await ingestChatbotKnowledge({
            pageId,
            userId: authorization.userId,
            title,
            content,
            sourceType,
            originalFilename
        });
        return NextResponse.json({ document }, { status: 201 });
    } catch (error) {
        const message = (error as Error).message;
        console.error('[CHATBOT_KNOWLEDGE_POST]', error);
        return NextResponse.json(
            { error: 'Failed to index chatbot knowledge', message },
            { status: message.includes('already indexed') ? 409 : 500 }
        );
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorization = await authorize(request, pageId);
        if (authorization.error) return authorization.error;

        const body = await request.json();
        const documentId = typeof body.document_id === 'string' ? body.document_id : '';
        if (!documentId) return NextResponse.json({ error: 'document_id is required' }, { status: 400 });

        const supabase = getSupabaseAdmin();
        const { data: linkedMedia, error: mediaError } = await supabase
            .from('chatbot_media_assets')
            .select('storage_bucket, storage_path')
            .eq('knowledge_document_id', documentId)
            .eq('page_id', pageId);
        if (mediaError) throw mediaError;

        for (const [bucket, paths] of Object.entries(
            (linkedMedia || []).reduce<Record<string, string[]>>((groups, media) => {
                groups[media.storage_bucket] = [...(groups[media.storage_bucket] || []), media.storage_path];
                return groups;
            }, {})
        )) {
            const { error: storageError } = await supabase.storage.from(bucket).remove(paths);
            if (storageError) throw storageError;
        }

        const { data, error } = await supabase
            .from('chatbot_knowledge_documents')
            .delete()
            .eq('id', documentId)
            .eq('page_id', pageId)
            .select('id')
            .maybeSingle();
        if (error) throw error;
        if (!data) return NextResponse.json({ error: 'Knowledge document not found' }, { status: 404 });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('[CHATBOT_KNOWLEDGE_DELETE]', error);
        return NextResponse.json(
            { error: 'Failed to delete chatbot knowledge', message: (error as Error).message },
            { status: 500 }
        );
    }
}
