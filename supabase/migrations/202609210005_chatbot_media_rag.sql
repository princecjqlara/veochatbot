-- Page-scoped chatbot images/videos with multimodal RAG linkage.

BEGIN;

CREATE TABLE IF NOT EXISTS public.chatbot_media_assets (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    knowledge_document_id UUID UNIQUE REFERENCES public.chatbot_knowledge_documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    usage_notes TEXT NOT NULL DEFAULT '',
    media_type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    storage_bucket TEXT NOT NULL DEFAULT 'chatbot-media',
    storage_path TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL CHECK (file_size > 0),
    analysis_text TEXT,
    auto_send BOOLEAN NOT NULL DEFAULT TRUE,
    status TEXT NOT NULL DEFAULT 'processing',
    error_message TEXT,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chatbot_media_assets_media_type_check CHECK (media_type IN ('image', 'video')),
    CONSTRAINT chatbot_media_assets_status_check CHECK (status IN ('processing', 'ready', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_chatbot_media_assets_page_created
    ON public.chatbot_media_assets(page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chatbot_media_assets_page_document
    ON public.chatbot_media_assets(page_id, knowledge_document_id)
    WHERE status = 'ready' AND auto_send;

DROP TRIGGER IF EXISTS update_chatbot_media_assets_updated_at
    ON public.chatbot_media_assets;
CREATE TRIGGER update_chatbot_media_assets_updated_at
    BEFORE UPDATE ON public.chatbot_media_assets
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.chatbot_media_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chatbot_media_assets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.chatbot_media_assets TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260921_017', 'Page-scoped image and video assets linked to chatbot RAG')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
