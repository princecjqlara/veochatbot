-- Let the chatbot choose a natural number of Messenger bubbles without a fixed cap.

BEGIN;

ALTER TABLE public.chatbot_configs
    DROP CONSTRAINT IF EXISTS chatbot_configs_max_message_parts_check;

UPDATE public.chatbot_configs
SET max_message_parts = 0
WHERE max_message_parts <> 0;

ALTER TABLE public.chatbot_configs
    ALTER COLUMN max_message_parts SET DEFAULT 0,
    ADD CONSTRAINT chatbot_configs_max_message_parts_check
        CHECK (max_message_parts >= 0);

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260921_018', 'Automatic natural chatbot bubble count without a fixed maximum')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
