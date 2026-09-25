import { getSupabaseAdmin } from '@/lib/supabase';
import { ingestChatbotKnowledge } from '@/lib/chatbot-knowledge';
import {
    analyzeChatbotMedia,
    CHATBOT_MEDIA_BUCKET,
    CHATBOT_MEDIA_MIME_TYPES,
    createChatbotMediaSignedUrl,
    ensureChatbotMediaBucket,
    MAX_CHATBOT_MEDIA_BYTES,
    type ChatbotMediaAsset
} from '@/lib/chatbot-media';

type TelegramFile = {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    file_name?: string;
    mime_type?: string;
};

export type TelegramMessage = {
    message_id: number;
    date?: number;
    media_group_id?: string;
    caption?: string;
    chat: { id: number; title?: string; type?: string };
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
    photo?: Array<TelegramFile & { width?: number; height?: number }>;
    video?: TelegramFile;
    animation?: TelegramFile;
    document?: TelegramFile;
};

export type TelegramMediaCandidate = {
    telegramFileId: string;
    telegramFileUniqueId: string;
    fileName: string;
    mimeType: string;
    fileSize: number | null;
    mediaType: 'image' | 'video';
};

type TelegramGetFileResponse = {
    ok?: boolean;
    description?: string;
    result?: { file_id: string; file_unique_id: string; file_size?: number; file_path?: string };
};

class TelegramMediaTooLargeError extends Error {}

const extensionByMimeType: Record<string, string> = Object.fromEntries(
    Object.entries(CHATBOT_MEDIA_MIME_TYPES).map(([mimeType, value]) => [mimeType, value.extension])
);

function resolveMimeType(file: TelegramFile, fallback = '') {
    const supplied = file.mime_type?.toLowerCase().trim() || '';
    if (CHATBOT_MEDIA_MIME_TYPES[supplied]) return supplied;
    const extension = file.file_name?.split('.').pop()?.toLowerCase() || '';
    const fromExtension = Object.entries(CHATBOT_MEDIA_MIME_TYPES)
        .find(([, value]) => value.extension === extension)?.[0];
    return fromExtension || fallback;
}

export function extractTelegramMediaCandidate(message: TelegramMessage): TelegramMediaCandidate | null {
    const largestPhoto = message.photo?.length
        ? [...message.photo].sort((a, b) => (b.file_size || 0) - (a.file_size || 0))[0]
        : null;
    const file = largestPhoto || message.video || message.animation || message.document;
    if (!file?.file_id || !file.file_unique_id) return null;

    const fallbackMime = largestPhoto
        ? 'image/jpeg'
        : message.video || message.animation
            ? 'video/mp4'
            : '';
    const mimeType = resolveMimeType(file, fallbackMime);
    const supported = CHATBOT_MEDIA_MIME_TYPES[mimeType];
    if (!supported) return null;

    const extension = extensionByMimeType[mimeType];
    return {
        telegramFileId: file.file_id,
        telegramFileUniqueId: file.file_unique_id,
        fileName: file.file_name?.trim().slice(0, 255) ||
            `telegram-${supported.mediaType}-${message.message_id}.${extension}`,
        mimeType,
        fileSize: Number.isFinite(file.file_size) ? Number(file.file_size) : null,
        mediaType: supported.mediaType
    };
}

function buildMediaTitle(message: TelegramMessage, candidate: TelegramMediaCandidate) {
    const captionTitle = message.caption?.split(/\r?\n/)[0]?.trim();
    const filenameTitle = candidate.fileName
        .replace(/\.[^.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (captionTitle || filenameTitle || `Telegram ${candidate.mediaType}`).slice(0, 160);
}

function buildUsageNotes(message: TelegramMessage) {
    const parts = [
        message.caption?.trim() ? `Telegram caption: ${message.caption.trim()}` : '',
        message.chat.title?.trim() ? `Imported from approved Telegram group: ${message.chat.title.trim()}` : '',
        'Use this media only when it directly supports the customer conversation.'
    ];
    return parts.filter(Boolean).join('\n').slice(0, 3000);
}

async function fetchTelegramFile(input: {
    botToken: string;
    candidate: TelegramMediaCandidate;
}) {
    const fileResponse = await fetch(
        `https://api.telegram.org/bot${input.botToken}/getFile?file_id=${encodeURIComponent(input.candidate.telegramFileId)}`,
        { signal: AbortSignal.timeout(20_000) }
    );
    const fileBody = await fileResponse.json().catch(() => ({})) as TelegramGetFileResponse;
    if (!fileResponse.ok || !fileBody.ok || !fileBody.result?.file_path) {
        throw new Error(fileBody.description || `Telegram getFile failed (${fileResponse.status})`);
    }
    const fileSize = Number(fileBody.result.file_size ?? input.candidate.fileSize);
    if (Number.isFinite(fileSize) && fileSize > MAX_CHATBOT_MEDIA_BYTES) {
        throw new TelegramMediaTooLargeError(
            `Telegram media exceeds VeoBot's ${MAX_CHATBOT_MEDIA_BYTES / 1024 / 1024} MB limit`
        );
    }

    const downloadResponse = await fetch(
        `https://api.telegram.org/file/bot${input.botToken}/${fileBody.result.file_path}`,
        { signal: AbortSignal.timeout(60_000) }
    );
    if (!downloadResponse.ok) throw new Error(`Telegram file download failed (${downloadResponse.status})`);
    const contentLength = Number(downloadResponse.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_CHATBOT_MEDIA_BYTES) {
        throw new TelegramMediaTooLargeError(
            `Telegram media exceeds VeoBot's ${MAX_CHATBOT_MEDIA_BYTES / 1024 / 1024} MB limit`
        );
    }
    const bytes = Buffer.from(await downloadResponse.arrayBuffer());
    if (bytes.length <= 0) throw new Error('Telegram media file is empty');
    if (bytes.length > MAX_CHATBOT_MEDIA_BYTES) {
        throw new TelegramMediaTooLargeError(
            `Telegram media exceeds VeoBot's ${MAX_CHATBOT_MEDIA_BYTES / 1024 / 1024} MB limit`
        );
    }
    return bytes;
}

export async function ingestTelegramMedia(input: {
    botToken: string;
    pageId: string;
    message: TelegramMessage;
}) {
    const candidate = extractTelegramMediaCandidate(input.message);
    if (!candidate) return { status: 'ignored' as const, reason: 'No supported image or video found' };
    if (candidate.fileSize !== null && candidate.fileSize > MAX_CHATBOT_MEDIA_BYTES) {
        return { status: 'skipped' as const, reason: `File exceeds ${MAX_CHATBOT_MEDIA_BYTES / 1024 / 1024} MB` };
    }

    const safeUniqueId = candidate.telegramFileUniqueId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160);
    const extension = extensionByMimeType[candidate.mimeType];
    const storagePath = `telegram/${input.pageId}/${input.message.chat.id}/${safeUniqueId}.${extension}`;
    const supabase = getSupabaseAdmin();
    const { data: existing, error: existingError } = await supabase
        .from('chatbot_media_assets')
        .select('id, status, title, storage_bucket, storage_path, knowledge_document_id')
        .eq('page_id', input.pageId)
        .eq('storage_path', storagePath)
        .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    if (existing && existing.status !== 'failed') {
        return { status: 'duplicate' as const, assetId: existing.id, assetStatus: existing.status };
    }
    if (existing?.status === 'failed') {
        if (existing.knowledge_document_id) {
            await supabase.from('chatbot_knowledge_documents').delete().eq('id', existing.knowledge_document_id);
        } else {
            await supabase.from('chatbot_media_assets').delete().eq('id', existing.id);
        }
        await supabase.storage.from(existing.storage_bucket).remove([existing.storage_path]);
    }

    const { data: membership, error: membershipError } = await supabase
        .from('user_pages')
        .select('user_id')
        .eq('page_id', input.pageId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (membershipError || !membership?.user_id) {
        throw new Error(membershipError?.message || 'The mapped Page has no owner or member');
    }

    let assetId: string | null = null;
    let knowledgeDocumentId: string | null = null;
    let uploaded = false;
    try {
        let bytes: Buffer;
        try {
            bytes = await fetchTelegramFile({ botToken: input.botToken, candidate });
        } catch (error) {
            if (error instanceof TelegramMediaTooLargeError) {
                return { status: 'skipped' as const, reason: error.message };
            }
            throw error;
        }
        await ensureChatbotMediaBucket();
        const { error: uploadError } = await supabase.storage
            .from(CHATBOT_MEDIA_BUCKET)
            .upload(storagePath, bytes, {
                contentType: candidate.mimeType,
                upsert: true
            });
        if (uploadError) throw new Error(uploadError.message || 'Could not store Telegram media');
        uploaded = true;

        const title = buildMediaTitle(input.message, candidate);
        const usageNotes = buildUsageNotes(input.message);
        const { data: asset, error: assetError } = await supabase
            .from('chatbot_media_assets')
            .insert({
                page_id: input.pageId,
                title,
                usage_notes: usageNotes,
                media_type: candidate.mediaType,
                mime_type: candidate.mimeType,
                original_filename: candidate.fileName,
                storage_bucket: CHATBOT_MEDIA_BUCKET,
                storage_path: storagePath,
                file_size: bytes.length,
                status: 'processing',
                auto_send: true,
                created_by: membership.user_id
            })
            .select('id, page_id, knowledge_document_id, title, usage_notes, media_type, mime_type, original_filename, storage_bucket, storage_path, file_size, analysis_text, auto_send, status, error_message, created_at, updated_at')
            .single();
        if (assetError || !asset) throw new Error(assetError?.message || 'Could not create Telegram media asset');
        const typedAsset = asset as unknown as ChatbotMediaAsset;
        assetId = typedAsset.id;

        const signedUrl = await createChatbotMediaSignedUrl(typedAsset);
        const analysis = await analyzeChatbotMedia({
            signedUrl,
            mediaType: candidate.mediaType,
            title,
            usageNotes
        });
        const knowledgeContent = [
            `MEDIA ASSET (${candidate.mediaType.toUpperCase()}): ${title}`,
            `Owner guidance and when to send: ${usageNotes}`,
            `Automatic visual analysis: ${analysis}`,
            'When this media is directly useful, select its linked document ID so it can be sent to the customer.'
        ].join('\n\n');
        const document = await ingestChatbotKnowledge({
            pageId: input.pageId,
            userId: membership.user_id,
            title: `[${candidate.mediaType}] ${title}`,
            content: knowledgeContent,
            sourceType: 'file',
            originalFilename: candidate.fileName
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
            .eq('page_id', input.pageId)
            .select('id, status, title, media_type, file_size')
            .single();
        if (updateError || !readyAsset) throw new Error(updateError?.message || 'Could not finalize Telegram media');
        return { status: 'ready' as const, asset: readyAsset };
    } catch (error) {
        if (knowledgeDocumentId) {
            await supabase.from('chatbot_knowledge_documents').delete().eq('id', knowledgeDocumentId);
        } else if (assetId) {
            await supabase.from('chatbot_media_assets').update({
                status: 'failed',
                error_message: (error as Error).message.slice(0, 1000)
            }).eq('id', assetId);
        } else if (uploaded) {
            await supabase.storage.from(CHATBOT_MEDIA_BUCKET).remove([storagePath]);
        }
        throw error;
    }
}
