-- Include Business Suite lead-stage changes in the chatbot interruption audit.

BEGIN;

ALTER TABLE public.chatbot_interruption_events
    ADD COLUMN IF NOT EXISTS interruption_type TEXT NOT NULL DEFAULT 'manual_message',
    ADD COLUMN IF NOT EXISTS lead_stage TEXT;

ALTER TABLE public.chatbot_interruption_events
    DROP CONSTRAINT IF EXISTS chatbot_interruption_events_type_check,
    ADD CONSTRAINT chatbot_interruption_events_type_check
        CHECK (interruption_type IN ('manual_message', 'lead_stage_change')),
    DROP CONSTRAINT IF EXISTS chatbot_interruption_events_lead_stage_check,
    ADD CONSTRAINT chatbot_interruption_events_lead_stage_check
        CHECK (lead_stage IS NULL OR lead_stage IN (
            'qualified',
            'not_qualified',
            'converted',
            'order_created'
        ));

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260929_001', 'Log lead-stage changes that interrupt chatbot detail collection')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
