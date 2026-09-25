import { getSupabaseAdmin } from '@/lib/supabase';

export const CHATBOT_MEDIA_BUCKET = 'chatbot-media';
export const MAX_CHATBOT_MEDIA_BYTES = 50 * 1024 * 1024;
export const MAX_CHATBOT_MEDIA_FILES_PER_BATCH = 100;
export const DEFAULT_MULTIMODAL_MODEL = 'google/gemini-3.8-flash';

export const CHATBOT_MEDIA_MIME_TYPES: Record<string, {
    mediaType: 'image' | 'video';
    extension: string;
}> = {
    'image/jpeg': { mediaType: 'image', extension: 'jpg' },
    'image/png': { mediaType: 'image', extension: 'png' },
    'image/webp': { mediaType: 'image', extension: 'webp' },
    'image/gif': { mediaType: 'image', extension: 'gif' },
    'video/mp4': { mediaType: 'video', extension: 'mp4' },
    'video/quicktime': { mediaType: 'video', extension: 'mov' },
    'video/webm': { mediaType: 'video', extension: 'webm' }
};

export type ChatbotMediaAsset = {
    id: string;
    page_id: string;
    knowledge_document_id: string | null;
    title: string;
    usage_notes: string;
    media_type: 'image' | 'video';
    mime_type: string;
    original_filename: string;
    source_folder: string;
    source_relative_path: string;
    storage_bucket: string;
    storage_path: string;
    file_size: number;
    analysis_text: string | null;
    auto_send: boolean;
    status: 'processing' | 'ready' | 'failed';
    error_message: string | null;
    created_at: string;
    updated_at: string;
};

type OpenRouterMultimodalResponse = {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
};

export async function ensureChatbotMediaBucket() {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase.storage.getBucket(CHATBOT_MEDIA_BUCKET);
    const options = {
        public: false,
        fileSizeLimit: MAX_CHATBOT_MEDIA_BYTES,
        allowedMimeTypes: Object.keys(CHATBOT_MEDIA_MIME_TYPES)
    };
    if (data) {
        const { error } = await supabase.storage.updateBucket(CHATBOT_MEDIA_BUCKET, options);
        if (error) throw error;
        return;
    }

    const { error } = await supabase.storage.createBucket(CHATBOT_MEDIA_BUCKET, options);
    if (error) {
        const retry = await supabase.storage.getBucket(CHATBOT_MEDIA_BUCKET);
        if (!retry.data) throw error;
    }
}

export function normalizeChatbotMediaSourcePath(relativePath: string, fileName: string) {
    const fallback = fileName.trim().slice(0, 255);
    const normalized = relativePath
        .replace(/\\/g, '/')
        .split('/')
        .map((part) => part.trim())
        .filter((part) => part && part !== '.' && part !== '..')
        .join('/')
        .slice(0, 1000);
    const sourceRelativePath = normalized || fallback;
    const pathParts = sourceRelativePath.split('/');
    return {
        sourceRelativePath,
        sourceFolder: pathParts.length > 1 ? pathParts[0].slice(0, 255) : ''
    };
}

export function createChatbotMediaPublicViewUrl(assetId: string) {
    const candidates = [
        process.env.PUBLIC_APP_URL,
        process.env.NEXTAUTH_URL,
        process.env.FACEBOOK_WEBHOOK_URL
    ];
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            const url = new URL(candidate);
            return `${url.origin}/api/chatbot-media/${encodeURIComponent(assetId)}`;
        } catch {
            // Try the next configured public URL.
        }
    }
    return `/api/chatbot-media/${encodeURIComponent(assetId)}`;
}

export async function analyzeChatbotMedia(input: {
    signedUrl: string;
    mediaType: 'image' | 'video';
    title: string;
    usageNotes?: string;
}): Promise<string> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.mediaType === 'video' ? 120_000 : 60_000);
    const contentType = input.mediaType === 'image' ? 'image_url' : 'video_url';
    const prompt = [
        `Analyze this ${input.mediaType} for a customer-support knowledge base.`,
        `Asset title: ${input.title}.`,
        input.usageNotes?.trim() ? `Owner guidance: ${input.usageNotes.trim()}.` : '',
        'Describe the products, services, people, setting, actions, and important visual details.',
        'Transcribe visible text, prices, labels, and spoken information when available.',
        'State what customer questions this asset can help answer and when sending it would be useful.',
        'Do not invent facts that are not present. Return plain searchable text only.'
    ].filter(Boolean).join(' ');

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': process.env.NEXTAUTH_URL || 'http://localhost:3000',
                'X-OpenRouter-Title': 'VeoBot Media RAG'
            },
            body: JSON.stringify({
                model: process.env.OPENROUTER_MULTIMODAL_MODEL || DEFAULT_MULTIMODAL_MODEL,
                max_tokens: input.mediaType === 'video' ? 1200 : 800,
                temperature: 0.1,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: contentType, [contentType]: { url: input.signedUrl } }
                    ]
                }]
            }),
            signal: controller.signal
        });
        const body = await response.json().catch(() => ({})) as OpenRouterMultimodalResponse;
        if (!response.ok) {
            throw new Error(body.error?.message || `OpenRouter media analysis failed (${response.status})`);
        }
        const analysis = body.choices?.[0]?.message?.content?.trim();
        if (!analysis) throw new Error('OpenRouter returned no media analysis');
        return analysis.slice(0, 20_000);
    } finally {
        clearTimeout(timeout);
    }
}

export async function getReadyChatbotMediaForDocument(input: {
    pageId: string;
    documentId: string;
}): Promise<ChatbotMediaAsset | null> {
    const { data, error } = await getSupabaseAdmin()
        .from('chatbot_media_assets')
        .select('id, page_id, knowledge_document_id, title, usage_notes, media_type, mime_type, original_filename, source_folder, source_relative_path, storage_bucket, storage_path, file_size, analysis_text, auto_send, status, error_message, created_at, updated_at')
        .eq('page_id', input.pageId)
        .eq('knowledge_document_id', input.documentId)
        .eq('status', 'ready')
        .eq('auto_send', true)
        .maybeSingle();
    if (error) throw new Error(error.message || 'Could not load chatbot media');
    return data as ChatbotMediaAsset | null;
}

export async function getReadyChatbotMediaForDocuments(input: {
    pageId: string;
    documentIds: string[];
}): Promise<ChatbotMediaAsset[]> {
    const documentIds = [...new Set(input.documentIds.filter(Boolean))].slice(0, 10);
    if (documentIds.length === 0) return [];
    const { data, error } = await getSupabaseAdmin()
        .from('chatbot_media_assets')
        .select('id, page_id, knowledge_document_id, title, usage_notes, media_type, mime_type, original_filename, source_folder, source_relative_path, storage_bucket, storage_path, file_size, analysis_text, auto_send, status, error_message, created_at, updated_at')
        .eq('page_id', input.pageId)
        .in('knowledge_document_id', documentIds)
        .eq('status', 'ready')
        .eq('auto_send', true);
    if (error) throw new Error(error.message || 'Could not load chatbot media');

    const order = new Map(documentIds.map((documentId, index) => [documentId, index]));
    return ((data || []) as ChatbotMediaAsset[])
        .sort((left, right) =>
            (order.get(left.knowledge_document_id || '') ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right.knowledge_document_id || '') ?? Number.MAX_SAFE_INTEGER)
        );
}

export async function createChatbotMediaSignedUrl(asset: Pick<ChatbotMediaAsset, 'storage_bucket' | 'storage_path'>) {
    const { data, error } = await getSupabaseAdmin().storage
        .from(asset.storage_bucket)
        .createSignedUrl(asset.storage_path, 24 * 60 * 60);
    if (error || !data?.signedUrl) throw error || new Error('Could not create chatbot media URL');
    return data.signedUrl;
}
