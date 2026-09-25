import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { userHasPageAccess } from '@/lib/page-access';
import { ingestChatbotKnowledge } from '@/lib/chatbot-knowledge';
import {
    analyzeChatbotMedia,
    CHATBOT_MEDIA_BUCKET,
    CHATBOT_MEDIA_MIME_TYPES,
    createChatbotMediaSignedUrl,
    ensureChatbotMediaBucket,
    MAX_CHATBOT_MEDIA_BYTES,
    normalizeChatbotMediaSourcePath,
    type ChatbotMediaAsset
} from '@/lib/chatbot-media';

export const maxDuration = 300;

async function authorize(request: NextRequest, pageId: string) {
    const session = await getSessionFromRequest(request);
    const userId = session?.user?.id;
    if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    if (!await userHasPageAccess(userId, pageId)) {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    return { userId };
}

function selectMediaFields() {
    return 'id, page_id, knowledge_document_id, title, usage_notes, media_type, mime_type, original_filename, source_folder, source_relative_path, storage_bucket, storage_path, file_size, analysis_text, auto_send, status, error_message, created_at, updated_at';
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
            .from('chatbot_media_assets')
            .select(selectMediaFields())
            .eq('page_id', pageId)
            .order('created_at', { ascending: false });
        if (error) throw error;

        const assets = await Promise.all(((data || []) as unknown as ChatbotMediaAsset[]).map(async (asset) => {
            try {
                return { ...asset, preview_url: await createChatbotMediaSignedUrl(asset) };
            } catch {
                return { ...asset, preview_url: null };
            }
        }));
        return NextResponse.json({ assets });
    } catch (error) {
        console.error('[CHATBOT_MEDIA_GET]', error);
        return NextResponse.json(
            { error: 'Failed to load chatbot media', message: (error as Error).message },
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
        const body = await request.json().catch(() => ({}));
        const mimeType = typeof body.mime_type === 'string' ? body.mime_type.toLowerCase() : '';
        const fileSize = Number(body.file_size);
        const fileName = typeof body.file_name === 'string' ? body.file_name.trim().slice(0, 255) : '';
        const supported = CHATBOT_MEDIA_MIME_TYPES[mimeType];
        if (!supported || !fileName || !Number.isInteger(fileSize) || fileSize <= 0 || fileSize > MAX_CHATBOT_MEDIA_BYTES) {
            return NextResponse.json(
                { error: 'Choose a supported JPG, PNG, WebP, GIF, MP4, MOV, or WebM file up to 50 MB' },
                { status: 400 }
            );
        }

        await ensureChatbotMediaBucket();
        const path = `${authorization.userId}/${pageId}/${randomUUID()}.${supported.extension}`;
        const { data, error } = await getSupabaseAdmin().storage
            .from(CHATBOT_MEDIA_BUCKET)
            .createSignedUploadUrl(path);
        if (error || !data?.token) throw error || new Error('Could not prepare chatbot media upload');

        return NextResponse.json({
            bucket: CHATBOT_MEDIA_BUCKET,
            path,
            token: data.token,
            media_type: supported.mediaType
        });
    } catch (error) {
        console.error('[CHATBOT_MEDIA_PREPARE]', error);
        return NextResponse.json(
            { error: 'Failed to prepare chatbot media upload', message: (error as Error).message },
            { status: 500 }
        );
    }
}

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    let assetId: string | null = null;
    let knowledgeDocumentId: string | null = null;
    try {
        const { pageId } = await params;
        const authorization = await authorize(request, pageId);
        if (authorization.error || !authorization.userId) return authorization.error;
        const body = await request.json().catch(() => ({}));
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 160) : '';
        const usageNotes = typeof body.usage_notes === 'string' ? body.usage_notes.trim().slice(0, 3000) : '';
        const path = typeof body.path === 'string' ? body.path.trim() : '';
        const mimeType = typeof body.mime_type === 'string' ? body.mime_type.toLowerCase() : '';
        const fileSize = Number(body.file_size);
        const fileName = typeof body.file_name === 'string' ? body.file_name.trim().slice(0, 255) : '';
        const source = normalizeChatbotMediaSourcePath(
            typeof body.source_relative_path === 'string' ? body.source_relative_path : '',
            fileName
        );
        const supported = CHATBOT_MEDIA_MIME_TYPES[mimeType];
        const expectedPrefix = `${authorization.userId}/${pageId}/`;
        if (!title || !path.startsWith(expectedPrefix) || !supported || !fileName ||
            !Number.isInteger(fileSize) || fileSize <= 0 || fileSize > MAX_CHATBOT_MEDIA_BYTES) {
            return NextResponse.json({ error: 'Invalid chatbot media details' }, { status: 400 });
        }

        const supabase = getSupabaseAdmin();
        const { data: asset, error: assetError } = await supabase
            .from('chatbot_media_assets')
            .insert({
                page_id: pageId,
                title,
                usage_notes: usageNotes,
                media_type: supported.mediaType,
                mime_type: mimeType,
                original_filename: fileName,
                source_folder: source.sourceFolder,
                source_relative_path: source.sourceRelativePath,
                storage_bucket: CHATBOT_MEDIA_BUCKET,
                storage_path: path,
                file_size: fileSize,
                status: 'processing',
                auto_send: body.auto_send !== false,
                created_by: authorization.userId
            })
            .select(selectMediaFields())
            .single();
        if (assetError || !asset) throw assetError || new Error('Could not create chatbot media asset');
        const typedAsset = asset as unknown as ChatbotMediaAsset;
        assetId = typedAsset.id;

        const signedUrl = await createChatbotMediaSignedUrl(typedAsset);
        let analysisWarning = '';
        let analysis: string;
        try {
            analysis = await analyzeChatbotMedia({
                signedUrl,
                mediaType: supported.mediaType,
                title,
                usageNotes
            });
        } catch (analysisError) {
            analysisWarning = (analysisError as Error).message.slice(0, 500);
            analysis = [
                `Automatic visual analysis was unavailable for this ${supported.mediaType}.`,
                `Use its title, filename, folder path, and owner guidance to decide when it is relevant.`
            ].join(' ');
        }
        const knowledgeContent = [
            `MEDIA ASSET (${supported.mediaType.toUpperCase()}): ${title}`,
            source.sourceFolder ? `Source folder: ${source.sourceFolder}` : '',
            `Source file path: ${source.sourceRelativePath}`,
            `Original filename: ${fileName}`,
            usageNotes ? `Owner guidance and when to send: ${usageNotes}` : '',
            `Automatic visual analysis: ${analysis}`,
            `When this media is directly useful, select its linked document ID so it can be sent to the customer.`
        ].filter(Boolean).join('\n\n');
        const document = await ingestChatbotKnowledge({
            pageId,
            userId: authorization.userId,
            title: `[${supported.mediaType}] ${title}`,
            content: knowledgeContent,
            sourceType: 'file',
            originalFilename: fileName
        });
        knowledgeDocumentId = document.id;

        const { data: readyAsset, error: updateError } = await supabase
            .from('chatbot_media_assets')
            .update({
                knowledge_document_id: document.id,
                analysis_text: analysis,
                status: 'ready',
                error_message: null
            })
            .eq('id', typedAsset.id)
            .eq('page_id', pageId)
            .select(selectMediaFields())
            .single();
        if (updateError || !readyAsset) throw updateError || new Error('Could not finalize chatbot media');
        const typedReadyAsset = readyAsset as unknown as ChatbotMediaAsset;

        return NextResponse.json({
            asset: { ...typedReadyAsset, preview_url: signedUrl },
            document,
            ...(analysisWarning ? { warning: `Uploaded and indexed from its folder/file name, but visual analysis was skipped: ${analysisWarning}` } : {})
        }, { status: 201 });
    } catch (error) {
        if (knowledgeDocumentId) {
            await getSupabaseAdmin()
                .from('chatbot_knowledge_documents')
                .delete()
                .eq('id', knowledgeDocumentId);
        } else if (assetId) {
            await getSupabaseAdmin().from('chatbot_media_assets').update({
                status: 'failed',
                error_message: (error as Error).message.slice(0, 1000)
            }).eq('id', assetId);
        }
        console.error('[CHATBOT_MEDIA_FINALIZE]', error);
        return NextResponse.json(
            { error: 'Failed to analyze and index chatbot media', message: (error as Error).message },
            { status: 500 }
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
        const body = await request.json().catch(() => ({}));
        const assetId = typeof body.asset_id === 'string' ? body.asset_id : '';
        if (!assetId) return NextResponse.json({ error: 'asset_id is required' }, { status: 400 });

        const supabase = getSupabaseAdmin();
        const { data: asset, error } = await supabase
            .from('chatbot_media_assets')
            .select('id, knowledge_document_id, storage_bucket, storage_path')
            .eq('id', assetId)
            .eq('page_id', pageId)
            .maybeSingle();
        if (error) throw error;
        if (!asset) return NextResponse.json({ error: 'Chatbot media not found' }, { status: 404 });

        const { error: storageError } = await supabase.storage
            .from(asset.storage_bucket)
            .remove([asset.storage_path]);
        if (storageError) throw storageError;

        if (asset.knowledge_document_id) {
            const { error: documentError } = await supabase
                .from('chatbot_knowledge_documents')
                .delete()
                .eq('id', asset.knowledge_document_id)
                .eq('page_id', pageId);
            if (documentError) throw documentError;
        } else {
            const { error: deleteError } = await supabase
                .from('chatbot_media_assets')
                .delete()
                .eq('id', asset.id)
                .eq('page_id', pageId);
            if (deleteError) throw deleteError;
        }
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('[CHATBOT_MEDIA_DELETE]', error);
        return NextResponse.json(
            { error: 'Failed to delete chatbot media', message: (error as Error).message },
            { status: 500 }
        );
    }
}
