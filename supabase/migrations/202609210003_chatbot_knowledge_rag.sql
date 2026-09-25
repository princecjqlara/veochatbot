-- Page-scoped retrieval-augmented generation knowledge base for VeoBot.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS rag_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS public.chatbot_knowledge_documents (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'manual',
    original_filename TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    char_count INTEGER NOT NULL DEFAULT 0 CHECK (char_count >= 0),
    chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
    status TEXT NOT NULL DEFAULT 'processing',
    error_message TEXT,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chatbot_knowledge_documents_source_type_check
        CHECK (source_type IN ('manual', 'file')),
    CONSTRAINT chatbot_knowledge_documents_status_check
        CHECK (status IN ('processing', 'ready', 'failed')),
    UNIQUE (page_id, content_hash)
);

CREATE TABLE IF NOT EXISTS public.chatbot_knowledge_chunks (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES public.chatbot_knowledge_documents(id) ON DELETE CASCADE,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    content TEXT NOT NULL,
    char_count INTEGER NOT NULL CHECK (char_count > 0),
    embedding extensions.vector(1536) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chatbot_knowledge_documents_page_created
    ON public.chatbot_knowledge_documents(page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chatbot_knowledge_chunks_page
    ON public.chatbot_knowledge_chunks(page_id, document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chatbot_knowledge_chunks_embedding
    ON public.chatbot_knowledge_chunks
    USING hnsw (embedding extensions.vector_cosine_ops);

DROP TRIGGER IF EXISTS update_chatbot_knowledge_documents_updated_at
    ON public.chatbot_knowledge_documents;
CREATE TRIGGER update_chatbot_knowledge_documents_updated_at
    BEFORE UPDATE ON public.chatbot_knowledge_documents
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.match_chatbot_knowledge(
    p_page_id UUID,
    p_query_embedding extensions.vector(1536),
    p_match_threshold DOUBLE PRECISION DEFAULT 0.35,
    p_match_count INTEGER DEFAULT 5
)
RETURNS TABLE (
    chunk_id UUID,
    document_id UUID,
    title TEXT,
    content TEXT,
    similarity DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
    SELECT
        chunk.id,
        chunk.document_id,
        document.title,
        chunk.content,
        1 - (chunk.embedding <=> p_query_embedding) AS similarity
    FROM public.chatbot_knowledge_chunks AS chunk
    INNER JOIN public.chatbot_knowledge_documents AS document
        ON document.id = chunk.document_id
    WHERE chunk.page_id = p_page_id
      AND document.status = 'ready'
      AND 1 - (chunk.embedding <=> p_query_embedding) >= p_match_threshold
    ORDER BY chunk.embedding <=> p_query_embedding
    LIMIT LEAST(GREATEST(p_match_count, 1), 10);
$$;

ALTER TABLE public.chatbot_knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_knowledge_chunks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.chatbot_knowledge_documents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.chatbot_knowledge_chunks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.chatbot_knowledge_documents TO postgres, service_role;
GRANT ALL ON public.chatbot_knowledge_chunks TO postgres, service_role;

REVOKE ALL ON FUNCTION public.match_chatbot_knowledge(UUID, extensions.vector, DOUBLE PRECISION, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_chatbot_knowledge(UUID, extensions.vector, DOUBLE PRECISION, INTEGER)
    TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260921_015', 'Page-scoped pgvector knowledge base for VeoBot RAG')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
