-- Per-Page AI follow-up guidance and RAG-selected media for each scheduled job.

BEGIN;

ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS follow_up_ai_instructions TEXT NOT NULL DEFAULT
        'Write a fresh, personal follow-up based on this contact''s conversation. Do not repeat earlier wording. When relevant, offer helpful proof such as previous work, product photos, or a promotional video from the Page knowledge base.';

ALTER TABLE public.chatbot_configs
    DROP CONSTRAINT IF EXISTS chatbot_configs_follow_up_ai_instructions_length_check,
    ADD CONSTRAINT chatbot_configs_follow_up_ai_instructions_length_check
        CHECK (char_length(follow_up_ai_instructions) BETWEEN 1 AND 3000);

ALTER TABLE public.chatbot_follow_up_jobs
    ADD COLUMN IF NOT EXISTS media_asset_id UUID REFERENCES public.chatbot_media_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chatbot_follow_up_jobs_media_asset
    ON public.chatbot_follow_up_jobs(media_asset_id)
    WHERE media_asset_id IS NOT NULL;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260921_022', 'AI-personalized chatbot follow-ups with RAG-selected media')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
