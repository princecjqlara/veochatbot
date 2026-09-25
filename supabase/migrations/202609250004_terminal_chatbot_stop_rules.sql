-- Terminal Messenger outcomes always stop the chatbot and its follow-up flow.

BEGIN;

UPDATE public.chatbot_configs
SET
    stop_on_qualified = TRUE,
    stop_on_not_qualified = TRUE,
    stop_on_converted = TRUE,
    stop_on_order_created = TRUE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chatbot_configs_terminal_stops_required'
          AND conrelid = 'public.chatbot_configs'::regclass
    ) THEN
        ALTER TABLE public.chatbot_configs
            ADD CONSTRAINT chatbot_configs_terminal_stops_required
            CHECK (
                stop_on_qualified
                AND stop_on_not_qualified
                AND stop_on_converted
                AND stop_on_order_created
            );
    END IF;
END
$$;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260925_004', 'Make terminal Messenger outcomes mandatory chatbot stops')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
