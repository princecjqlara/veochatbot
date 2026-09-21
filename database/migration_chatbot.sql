BEGIN;

CREATE TABLE IF NOT EXISTS chatbot_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    page_id UUID NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    instructions TEXT NOT NULL DEFAULT 'You are a helpful customer support assistant for this Facebook Page. Be concise, friendly, accurate, and never invent prices, policies, availability, or promises.',
    fallback_reply TEXT NOT NULL DEFAULT 'Thanks for your message! A member of our team will get back to you shortly.',
    model TEXT NOT NULL DEFAULT '~deepseek/deepseek-flash-latest',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chatbot_reply_events (
    inbound_message_id TEXT PRIMARY KEY,
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    outbound_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chatbot_reply_events_status_check CHECK (status IN ('processing', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_chatbot_reply_events_page_created
    ON chatbot_reply_events(page_id, created_at DESC);

ALTER TABLE chatbot_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_reply_events ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_chatbot_configs_updated_at ON chatbot_configs;
CREATE TRIGGER update_chatbot_configs_updated_at
    BEFORE UPDATE ON chatbot_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE outbound_message_events
    DROP CONSTRAINT IF EXISTS outbound_message_events_source_type_check;
ALTER TABLE outbound_message_events
    ADD CONSTRAINT outbound_message_events_source_type_check
    CHECK (source_type IN ('manual', 'campaign', 'automation', 'welcome', 'chatbot'));

GRANT ALL ON chatbot_configs, chatbot_reply_events TO postgres, anon, authenticated, service_role;

COMMIT;
