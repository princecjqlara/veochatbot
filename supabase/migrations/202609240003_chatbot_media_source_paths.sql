-- Preserve uploaded folder structure so RAG can select media using folder and file names.

BEGIN;

ALTER TABLE public.chatbot_media_assets
    ADD COLUMN IF NOT EXISTS source_folder TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source_relative_path TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_chatbot_media_assets_page_source_folder
    ON public.chatbot_media_assets(page_id, source_folder)
    WHERE status = 'ready' AND auto_send;

NOTIFY pgrst, 'reload schema';

COMMIT;
