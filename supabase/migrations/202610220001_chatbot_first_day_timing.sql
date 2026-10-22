-- Adds an opt-in first-day timing policy without changing Page enable switches.
BEGIN;

ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS follow_up_first_day_mode text NOT NULL DEFAULT 'fixed'
        CHECK (follow_up_first_day_mode IN ('fixed', 'adaptive'));

ALTER TABLE public.chatbot_follow_up_jobs
    ADD COLUMN IF NOT EXISTS timing_context jsonb;
ALTER TABLE public.chatbot_follow_up_jobs
    DROP CONSTRAINT IF EXISTS chatbot_follow_up_jobs_purpose_check;
ALTER TABLE public.chatbot_follow_up_jobs
    ADD CONSTRAINT chatbot_follow_up_jobs_purpose_check
        CHECK (purpose IN ('scheduled', 'nightly_continuation', 'first_day_adaptive'));

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20261022_001', 'Opt-in original-first-day adaptive follow-up timing')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
COMMIT;
