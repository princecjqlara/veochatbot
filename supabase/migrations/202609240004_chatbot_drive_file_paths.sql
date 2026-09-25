-- Preserve the public Google Drive folder hierarchy for better sample matching.

BEGIN;

ALTER TABLE public.chatbot_drive_files
    ADD COLUMN IF NOT EXISTS relative_path TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_chatbot_drive_files_page_path
    ON public.chatbot_drive_files(page_id, relative_path);

NOTIFY pgrst, 'reload schema';

COMMIT;
