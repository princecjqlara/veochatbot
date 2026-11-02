BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A shared switch must not opt a Page into a different conversation flow.
-- Existing optional-assistant OFF settings continue to apply as well.
ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS pricing_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.chatbot_configs.pricing_enabled IS
    'Shared pricing permission for replies and follow-ups, independent of sales flow.';

NOTIFY pgrst, 'reload schema';
COMMIT;
