-- Complete VeoBot chatbot persistence and outbound-message attribution.
-- This migration is intentionally idempotent so it repairs partial/manual
-- deployments as well as clean Supabase projects.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.outbound_message_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    message_id TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    source_id UUID,
    source_name TEXT,
    actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    actor_name TEXT,
    message_kind TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbound_message_events_page_message
    ON public.outbound_message_events(page_id, message_id);
CREATE INDEX IF NOT EXISTS idx_outbound_message_events_page_sent
    ON public.outbound_message_events(page_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS public.chatbot_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    page_id UUID NOT NULL UNIQUE REFERENCES public.pages(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    instructions TEXT NOT NULL DEFAULT 'You are a helpful customer support assistant for this Facebook Page. Be concise, friendly, accurate, and never invent prices, policies, availability, or promises.',
    fallback_reply TEXT NOT NULL DEFAULT 'Thanks for your message! A member of our team will get back to you shortly.',
    model TEXT NOT NULL DEFAULT '~deepseek/deepseek-flash-latest',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.chatbot_reply_events (
    inbound_message_id TEXT PRIMARY KEY,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
    outbound_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chatbot_reply_events_status_check
        CHECK (status IN ('processing', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_chatbot_reply_events_page_created
    ON public.chatbot_reply_events(page_id, created_at DESC);

ALTER TABLE public.outbound_message_events
    DROP CONSTRAINT IF EXISTS outbound_message_events_source_type_check;
ALTER TABLE public.outbound_message_events
    ADD CONSTRAINT outbound_message_events_source_type_check
    CHECK (source_type IN ('manual', 'campaign', 'automation', 'welcome', 'chatbot'));

ALTER TABLE public.outbound_message_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_reply_events ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_chatbot_configs_updated_at ON public.chatbot_configs;
CREATE TRIGGER update_chatbot_configs_updated_at
    BEFORE UPDATE ON public.chatbot_configs
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

REVOKE ALL ON public.outbound_message_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.chatbot_configs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.chatbot_reply_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.outbound_message_events TO postgres, service_role;
GRANT ALL ON public.chatbot_configs TO postgres, service_role;
GRANT ALL ON public.chatbot_reply_events TO postgres, service_role;

CREATE SCHEMA IF NOT EXISTS app_private;
CREATE TABLE IF NOT EXISTS app_private.schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260921_013', 'VeoBot chatbot and outbound message attribution')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
