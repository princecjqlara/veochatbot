-- Individual Drive files are the send target. Do not fall back to sharing whole folders.

BEGIN;

UPDATE public.chatbot_drive_folders
SET auto_send = FALSE,
    updated_at = NOW()
WHERE auto_send = TRUE;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260924_002', 'Disable whole-folder chatbot sends in favor of indexed Drive files')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
