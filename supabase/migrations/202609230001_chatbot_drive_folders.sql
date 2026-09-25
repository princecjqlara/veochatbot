-- Searchable Google Drive media folders that VeoBot can share as Messenger buttons.

BEGIN;

CREATE TABLE IF NOT EXISTS public.chatbot_drive_folders (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    knowledge_document_id UUID UNIQUE REFERENCES public.chatbot_knowledge_documents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    folder_url TEXT NOT NULL,
    usage_notes TEXT NOT NULL DEFAULT '',
    button_text TEXT NOT NULL DEFAULT 'View media samples',
    auto_send BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chatbot_drive_folders_name_check CHECK (char_length(name) BETWEEN 1 AND 160),
    CONSTRAINT chatbot_drive_folders_url_check CHECK (folder_url ~ '^https://drive\.google\.com/drive/folders/[A-Za-z0-9_-]+$'),
    CONSTRAINT chatbot_drive_folders_button_check CHECK (char_length(button_text) BETWEEN 1 AND 20),
    UNIQUE (page_id, folder_url)
);

CREATE INDEX IF NOT EXISTS idx_chatbot_drive_folders_page_created
    ON public.chatbot_drive_folders(page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chatbot_drive_folders_page_document
    ON public.chatbot_drive_folders(page_id, knowledge_document_id)
    WHERE auto_send;

DROP TRIGGER IF EXISTS update_chatbot_drive_folders_updated_at
    ON public.chatbot_drive_folders;
CREATE TRIGGER update_chatbot_drive_folders_updated_at
    BEFORE UPDATE ON public.chatbot_drive_folders
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.chatbot_drive_folders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chatbot_drive_folders FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.chatbot_drive_folders TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260923_001', 'Page-scoped Google Drive media folders linked to chatbot RAG')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
