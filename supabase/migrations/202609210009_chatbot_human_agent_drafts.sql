-- Replace automated day 2-7 utility sends with staff-approved HUMAN_AGENT drafts.

BEGIN;

ALTER TABLE public.chatbot_follow_up_jobs
    DROP CONSTRAINT IF EXISTS chatbot_follow_up_jobs_schedule_type_check,
    DROP CONSTRAINT IF EXISTS chatbot_follow_up_jobs_status_check;

UPDATE public.chatbot_follow_up_jobs
SET schedule_type = 'manual_human_agent'
WHERE schedule_type = 'utility'
  AND status IN ('pending', 'processing');

ALTER TABLE public.chatbot_follow_up_jobs
    ADD CONSTRAINT chatbot_follow_up_jobs_schedule_type_check
        CHECK (schedule_type IN ('response', 'manual_human_agent')),
    ADD CONSTRAINT chatbot_follow_up_jobs_status_check
        CHECK (status IN ('pending', 'processing', 'ready_manual', 'sent', 'cancelled', 'failed'));

CREATE INDEX IF NOT EXISTS idx_chatbot_follow_up_jobs_ready_manual
    ON public.chatbot_follow_up_jobs(page_id, due_at, id)
    WHERE status = 'ready_manual';

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260921_021', 'Staff-approved Human Agent drafts for chatbot day 2-7 follow-ups')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
