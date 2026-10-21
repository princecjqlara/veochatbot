BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='20s';
ALTER TABLE public.chatbot_reply_events ADD COLUMN IF NOT EXISTS inbound_at timestamptz;
COMMENT ON COLUMN public.chatbot_reply_events.inbound_at IS 'Original signed webhook timestamp, including milliseconds, used when recovering this exact inbound message.';
INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261018_001','Preserve original inbound timestamps during missed-reply recovery')
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description;
NOTIFY pgrst,'reload schema';
COMMIT;
