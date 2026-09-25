-- Per-page behavior rules and percentage-based lead-detail collection targets.

BEGIN;

ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS details_completion_percent INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS bot_dos TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS bot_donts TEXT NOT NULL DEFAULT '';

ALTER TABLE public.chatbot_configs
    DROP CONSTRAINT IF EXISTS chatbot_configs_details_completion_percent_check,
    DROP CONSTRAINT IF EXISTS chatbot_configs_bot_dos_length_check,
    DROP CONSTRAINT IF EXISTS chatbot_configs_bot_donts_length_check,
    ADD CONSTRAINT chatbot_configs_details_completion_percent_check
        CHECK (details_completion_percent BETWEEN 1 AND 100),
    ADD CONSTRAINT chatbot_configs_bot_dos_length_check
        CHECK (char_length(bot_dos) <= 3000),
    ADD CONSTRAINT chatbot_configs_bot_donts_length_check
        CHECK (char_length(bot_donts) <= 3000);

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260921_019', 'Percentage detail targets plus per-page chatbot dos and donts')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
