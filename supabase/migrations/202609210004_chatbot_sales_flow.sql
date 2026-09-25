-- Controlled seven-day sales conversations, detail collection, and bot stop state.

BEGIN;

ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS follow_up_prompt TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS details_to_collect JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS split_messages BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS max_message_parts INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS stop_when_details_collected BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS stop_on_opt_out BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS stop_on_refusal BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS stop_on_qualified BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS stop_on_not_qualified BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS stop_on_converted BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS stop_on_order_created BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.chatbot_configs
    DROP CONSTRAINT IF EXISTS chatbot_configs_details_to_collect_array_check,
    ADD CONSTRAINT chatbot_configs_details_to_collect_array_check
        CHECK (jsonb_typeof(details_to_collect) = 'array'),
    DROP CONSTRAINT IF EXISTS chatbot_configs_max_message_parts_check,
    ADD CONSTRAINT chatbot_configs_max_message_parts_check
        CHECK (max_message_parts BETWEEN 1 AND 4);

CREATE TABLE IF NOT EXISTS public.chatbot_contact_states (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    collected_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    missing_details JSONB NOT NULL DEFAULT '[]'::jsonb,
    stop_reason TEXT,
    stopped_at TIMESTAMPTZ,
    last_inbound_at TIMESTAMPTZ,
    last_bot_reply_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (page_id, contact_id),
    CONSTRAINT chatbot_contact_states_status_check
        CHECK (status IN ('active', 'stopped')),
    CONSTRAINT chatbot_contact_states_collected_details_object_check
        CHECK (jsonb_typeof(collected_details) = 'object'),
    CONSTRAINT chatbot_contact_states_missing_details_array_check
        CHECK (jsonb_typeof(missing_details) = 'array'),
    CONSTRAINT chatbot_contact_states_window_check
        CHECK (window_expires_at >= started_at),
    CONSTRAINT chatbot_contact_states_stop_reason_check
        CHECK (stop_reason IS NULL OR stop_reason IN (
            'details_collected',
            'opt_out',
            'refusal',
            'qualified',
            'not_qualified',
            'converted',
            'order_created',
            'window_expired',
            'manual'
        ))
);

CREATE INDEX IF NOT EXISTS idx_chatbot_contact_states_page_status
    ON public.chatbot_contact_states(page_id, status, window_expires_at);
CREATE INDEX IF NOT EXISTS idx_chatbot_contact_states_contact
    ON public.chatbot_contact_states(contact_id);

DROP TRIGGER IF EXISTS update_chatbot_contact_states_updated_at
    ON public.chatbot_contact_states;
CREATE TRIGGER update_chatbot_contact_states_updated_at
    BEFORE UPDATE ON public.chatbot_contact_states
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.chatbot_contact_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chatbot_contact_states FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.chatbot_contact_states TO postgres, service_role;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260921_016', 'Seven-day chatbot sales flow, detail collection, and stop rules')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
