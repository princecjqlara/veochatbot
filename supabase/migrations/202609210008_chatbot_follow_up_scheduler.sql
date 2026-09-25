-- Policy-safe chatbot follow-ups: RESPONSE inside 24h, UTILITY templates on days 2-7.

BEGIN;

ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS follow_up_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS follow_up_quick_delays_minutes JSONB NOT NULL DEFAULT '[10, 60, 240, 720, 1380]'::jsonb,
    ADD COLUMN IF NOT EXISTS follow_up_best_time_days JSONB NOT NULL DEFAULT '[2, 3, 5, 7]'::jsonb,
    ADD COLUMN IF NOT EXISTS follow_up_messages JSONB NOT NULL DEFAULT '["Just checking in — would you like help with anything else?", "I am still here if you have questions about your request."]'::jsonb,
    ADD COLUMN IF NOT EXISTS follow_up_utility_template_name TEXT NOT NULL DEFAULT 'acct_followup_v1',
    ADD COLUMN IF NOT EXISTS follow_up_utility_template_language TEXT NOT NULL DEFAULT 'en_US',
    ADD COLUMN IF NOT EXISTS follow_up_utility_text TEXT NOT NULL DEFAULT 'We are following up on your recent request',
    ADD COLUMN IF NOT EXISTS follow_up_media_asset_id UUID REFERENCES public.chatbot_media_assets(id) ON DELETE SET NULL;

ALTER TABLE public.chatbot_configs
    DROP CONSTRAINT IF EXISTS chatbot_configs_follow_up_quick_delays_array_check,
    DROP CONSTRAINT IF EXISTS chatbot_configs_follow_up_best_days_array_check,
    DROP CONSTRAINT IF EXISTS chatbot_configs_follow_up_messages_array_check,
    DROP CONSTRAINT IF EXISTS chatbot_configs_follow_up_utility_text_length_check,
    ADD CONSTRAINT chatbot_configs_follow_up_quick_delays_array_check
        CHECK (jsonb_typeof(follow_up_quick_delays_minutes) = 'array'),
    ADD CONSTRAINT chatbot_configs_follow_up_best_days_array_check
        CHECK (jsonb_typeof(follow_up_best_time_days) = 'array'),
    ADD CONSTRAINT chatbot_configs_follow_up_messages_array_check
        CHECK (jsonb_typeof(follow_up_messages) = 'array'),
    ADD CONSTRAINT chatbot_configs_follow_up_utility_text_length_check
        CHECK (char_length(follow_up_utility_text) BETWEEN 1 AND 500);

CREATE TABLE IF NOT EXISTS public.chatbot_follow_up_jobs (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    anchor_inbound_at TIMESTAMPTZ NOT NULL,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('response', 'utility')),
    sequence_index INTEGER NOT NULL CHECK (sequence_index >= 0),
    due_at TIMESTAMPTZ NOT NULL,
    message_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'cancelled', 'failed')),
    message_id TEXT,
    error_message TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    claimed_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (contact_id, anchor_inbound_at, schedule_type, sequence_index)
);

CREATE INDEX IF NOT EXISTS idx_chatbot_follow_up_jobs_due
    ON public.chatbot_follow_up_jobs(due_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_chatbot_follow_up_jobs_contact
    ON public.chatbot_follow_up_jobs(contact_id, status, created_at DESC);

DROP TRIGGER IF EXISTS update_chatbot_follow_up_jobs_updated_at
    ON public.chatbot_follow_up_jobs;
CREATE TRIGGER update_chatbot_follow_up_jobs_updated_at
    BEFORE UPDATE ON public.chatbot_follow_up_jobs
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.chatbot_follow_up_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chatbot_follow_up_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.chatbot_follow_up_jobs TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260921_020', 'Policy-safe chatbot quick and best-time follow-up scheduler')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
