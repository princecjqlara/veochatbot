-- Send AI-personalized day 2-7 chatbot follow-ups directly with HUMAN_AGENT.

BEGIN;

ALTER TABLE public.chatbot_follow_up_jobs
    DROP CONSTRAINT IF EXISTS chatbot_follow_up_jobs_schedule_type_check;

ALTER TABLE public.chatbot_follow_up_jobs
    ADD CONSTRAINT chatbot_follow_up_jobs_schedule_type_check
        CHECK (schedule_type IN ('response', 'human_agent', 'manual_human_agent'));

UPDATE public.chatbot_follow_up_jobs
SET schedule_type = 'human_agent',
    status = 'pending',
    claimed_at = NULL,
    error_message = NULL,
    updated_at = NOW()
WHERE schedule_type = 'manual_human_agent'
  AND status IN ('pending', 'processing', 'ready_manual');

DROP INDEX IF EXISTS public.idx_chatbot_follow_up_jobs_ready_manual;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260922_001', 'Direct HUMAN_AGENT delivery for chatbot day 2-7 follow-ups')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
