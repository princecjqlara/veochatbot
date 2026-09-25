import { createHash } from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabase';

export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
export const MAX_KNOWLEDGE_CHARACTERS = 100_000;
export const MAX_KNOWLEDGE_CHUNKS = 100;
const CHUNK_SIZE = 1_200;
const CHUNK_OVERLAP = 180;
const EMBEDDING_BATCH_SIZE = 20;

export type ChatbotKnowledgeDocument = {
    id: string;
    page_id: string;
    title: string;
    source_type: 'manual' | 'file';
    original_filename: string | null;
    char_count: number;
    chunk_count: number;
    status: 'processing' | 'ready' | 'failed';
    error_message: string | null;
    created_at: string;
    updated_at: string;
};

export type ChatbotKnowledgeMatch = {
    chunk_id: string;
    document_id: string;
    title: string;
    content: string;
    similarity: number;
};

type EmbeddingsResponse = {
    data?: Array<{ index: number; embedding: number[] }>;
    error?: { message?: string };
};

function normalizeText(value: string) {
    return value
        .replace(/\r\n?/g, '\n')
        .replace(/[\t\f\v]+/g, ' ')
        .replace(/[ ]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function chunkKnowledgeText(value: string) {
    const text = normalizeText(value);
    if (!text) return [];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length && chunks.length < MAX_KNOWLEDGE_CHUNKS) {
        let end = Math.min(start + CHUNK_SIZE, text.length);

        if (end < text.length) {
            const searchStart = Math.max(start + Math.floor(CHUNK_SIZE * 0.6), end - 320);
            const boundaryArea = text.slice(searchStart, end);
            const boundaries = [
                boundaryArea.lastIndexOf('\n\n'),
                boundaryArea.lastIndexOf('. '),
                boundaryArea.lastIndexOf('? '),
                boundaryArea.lastIndexOf('! '),
                boundaryArea.lastIndexOf('\n'),
                boundaryArea.lastIndexOf(' ')
            ];
            const boundary = Math.max(...boundaries);
            if (boundary >= 0) end = searchStart + boundary + 1;
        }

        const chunk = text.slice(start, end).trim();
        if (chunk) chunks.push(chunk);
        if (end >= text.length) {
            start = text.length;
            break;
        }

        const nextStart = Math.max(start + 1, end - CHUNK_OVERLAP);
        start = nextStart;
        while (start < text.length && /\s/.test(text[start])) start += 1;
    }

    if (start < text.length) {
        throw new Error(`Knowledge content is too large after chunking (maximum ${MAX_KNOWLEDGE_CHUNKS} chunks)`);
    }

    return chunks;
}

function openRouterHeaders() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');
    return {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXTAUTH_URL || 'http://localhost:3000',
        'X-OpenRouter-Title': 'VeoBot RAG'
    };
}

export async function generateEmbeddings(
    inputs: string[],
    inputType: 'search_document' | 'search_query'
) {
    if (inputs.length === 0) return [];
    const embeddings: number[][] = [];

    for (let offset = 0; offset < inputs.length; offset += EMBEDDING_BATCH_SIZE) {
        const batch = inputs.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);

        try {
            const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
                method: 'POST',
                headers: openRouterHeaders(),
                body: JSON.stringify({
                    model: process.env.OPENROUTER_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
                    input: batch,
                    input_type: inputType,
                    dimensions: EMBEDDING_DIMENSIONS
                }),
                signal: controller.signal
            });
            const body = await response.json().catch(() => ({})) as EmbeddingsResponse;
            if (!response.ok) {
                throw new Error(body.error?.message || `OpenRouter embeddings request failed (${response.status})`);
            }

            const ordered = [...(body.data || [])].sort((a, b) => a.index - b.index);
            if (ordered.length !== batch.length) throw new Error('OpenRouter returned an incomplete embeddings batch');
            for (const item of ordered) {
                if (!Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIMENSIONS) {
                    throw new Error(`Embedding dimension mismatch; expected ${EMBEDDING_DIMENSIONS}`);
                }
                embeddings.push(item.embedding);
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    return embeddings;
}

export async function ingestChatbotKnowledge(input: {
    pageId: string;
    userId: string;
    title: string;
    content: string;
    sourceType: 'manual' | 'file';
    originalFilename?: string | null;
}): Promise<ChatbotKnowledgeDocument> {
    const title = normalizeText(input.title).slice(0, 160);
    const content = normalizeText(input.content);
    if (!title) throw new Error('Knowledge title is required');
    if (content.length < 20) throw new Error('Knowledge content must contain at least 20 characters');
    if (content.length > MAX_KNOWLEDGE_CHARACTERS) {
        throw new Error(`Knowledge content cannot exceed ${MAX_KNOWLEDGE_CHARACTERS.toLocaleString()} characters`);
    }

    const chunks = chunkKnowledgeText(content);
    if (chunks.length === 0) throw new Error('Knowledge content did not produce any searchable chunks');

    const supabase = getSupabaseAdmin();
    const contentHash = createHash('sha256').update(content).digest('hex');
    const { data: document, error: documentError } = await supabase
        .from('chatbot_knowledge_documents')
        .insert({
            page_id: input.pageId,
            title,
            source_type: input.sourceType,
            original_filename: input.originalFilename?.slice(0, 255) || null,
            content,
            content_hash: contentHash,
            char_count: content.length,
            chunk_count: 0,
            status: 'processing',
            created_by: input.userId
        })
        .select('id, page_id, title, source_type, original_filename, char_count, chunk_count, status, error_message, created_at, updated_at')
        .single();

    if (documentError) {
        if (documentError.code === '23505') throw new Error('This knowledge content is already indexed for the selected Page');
        throw new Error(documentError.message || 'Could not create knowledge document');
    }

    try {
        const embeddings = await generateEmbeddings(chunks, 'search_document');
        const rows = chunks.map((chunk, index) => ({
            document_id: document.id,
            page_id: input.pageId,
            chunk_index: index,
            content: chunk,
            char_count: chunk.length,
            embedding: JSON.stringify(embeddings[index])
        }));

        for (let offset = 0; offset < rows.length; offset += 100) {
            const { error } = await supabase
                .from('chatbot_knowledge_chunks')
                .insert(rows.slice(offset, offset + 100));
            if (error) throw new Error(error.message || 'Could not store knowledge chunks');
        }

        const { data: readyDocument, error: updateError } = await supabase
            .from('chatbot_knowledge_documents')
            .update({ status: 'ready', chunk_count: chunks.length, error_message: null })
            .eq('id', document.id)
            .eq('page_id', input.pageId)
            .select('id, page_id, title, source_type, original_filename, char_count, chunk_count, status, error_message, created_at, updated_at')
            .single();
        if (updateError) throw new Error(updateError.message || 'Could not finalize knowledge document');
        return readyDocument as ChatbotKnowledgeDocument;
    } catch (error) {
        await supabase.from('chatbot_knowledge_chunks').delete().eq('document_id', document.id);
        await supabase
            .from('chatbot_knowledge_documents')
            .update({
                status: 'failed',
                chunk_count: 0,
                error_message: (error as Error).message.slice(0, 1000)
            })
            .eq('id', document.id);
        throw error;
    }
}

export async function retrieveChatbotKnowledge(input: {
    pageId: string;
    query: string;
    matchCount?: number;
    matchThreshold?: number;
}): Promise<ChatbotKnowledgeMatch[]> {
    const query = normalizeText(input.query);
    if (!query) return [];
    const [embedding] = await generateEmbeddings([query], 'search_query');
    const configuredThreshold = Number(process.env.CHATBOT_RAG_MATCH_THRESHOLD || input.matchThreshold || 0.35);
    const matchThreshold = Math.min(0.95, Math.max(0, Number.isFinite(configuredThreshold) ? configuredThreshold : 0.35));
    const matchCount = Math.min(10, Math.max(1, input.matchCount || 5));

    const { data, error } = await getSupabaseAdmin().rpc('match_chatbot_knowledge', {
        p_page_id: input.pageId,
        p_query_embedding: JSON.stringify(embedding),
        p_match_threshold: matchThreshold,
        p_match_count: matchCount
    });
    if (error) throw new Error(error.message || 'Knowledge retrieval failed');

    return ((data || []) as ChatbotKnowledgeMatch[])
        .filter((match) => typeof match.content === 'string' && match.content.trim())
        .map((match) => ({ ...match, similarity: Number(match.similarity) }));
}
