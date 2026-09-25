-- Individually searchable Google Drive media files synced from Page folders.

BEGIN;

ALTER TABLE public.chatbot_drive_folders
    ADD COLUMN IF NOT EXISTS file_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'idle',
    ADD COLUMN IF NOT EXISTS sync_error TEXT;

ALTER TABLE public.chatbot_drive_folders
    DROP CONSTRAINT IF EXISTS chatbot_drive_folders_file_count_check,
    DROP CONSTRAINT IF EXISTS chatbot_drive_folders_sync_status_check,
    ADD CONSTRAINT chatbot_drive_folders_file_count_check CHECK (file_count >= 0),
    ADD CONSTRAINT chatbot_drive_folders_sync_status_check
        CHECK (sync_status IN ('idle', 'syncing', 'ready', 'failed'));

CREATE TABLE IF NOT EXISTS public.chatbot_drive_files (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    folder_id UUID NOT NULL REFERENCES public.chatbot_drive_folders(id) ON DELETE CASCADE,
    knowledge_document_id UUID UNIQUE REFERENCES public.chatbot_knowledge_documents(id) ON DELETE CASCADE,
    drive_file_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes BIGINT,
    web_view_url TEXT NOT NULL,
    thumbnail_url TEXT,
    modified_time TIMESTAMPTZ,
    auto_send BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chatbot_drive_files_media_type_check CHECK (media_type IN ('image', 'video')),
    CONSTRAINT chatbot_drive_files_name_check CHECK (char_length(name) BETWEEN 1 AND 255),
    CONSTRAINT chatbot_drive_files_view_url_check CHECK (web_view_url ~ '^https://drive\.google\.com/'),
    UNIQUE (folder_id, drive_file_id)
);

CREATE INDEX IF NOT EXISTS idx_chatbot_drive_files_page_created
    ON public.chatbot_drive_files(page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chatbot_drive_files_folder
    ON public.chatbot_drive_files(folder_id, name);
CREATE INDEX IF NOT EXISTS idx_chatbot_drive_files_page_document
    ON public.chatbot_drive_files(page_id, knowledge_document_id)
    WHERE auto_send;

DROP TRIGGER IF EXISTS update_chatbot_drive_files_updated_at
    ON public.chatbot_drive_files;
CREATE TRIGGER update_chatbot_drive_files_updated_at
    BEFORE UPDATE ON public.chatbot_drive_files
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.chatbot_drive_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chatbot_drive_files FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.chatbot_drive_files TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260924_001', 'Index individual Google Drive media files for RAG selection and Messenger cards')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
