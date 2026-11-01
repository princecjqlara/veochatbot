BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.chatbot_configs
    ALTER COLUMN model SET DEFAULT 'openai/gpt-6-luna';

-- Move Pages using the previous default while preserving custom model choices.
UPDATE public.chatbot_configs
SET model = 'openai/gpt-6-luna',
    updated_at = NOW()
WHERE model = '~deepseek/deepseek-flash-latest';

COMMIT;
