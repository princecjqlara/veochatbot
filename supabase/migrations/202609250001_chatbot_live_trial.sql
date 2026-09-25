-- Restrict the live Messenger chatbot to one explicitly selected contact while testing.

BEGIN;

ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS trial_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS trial_contact_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chatbot_configs_trial_contact_id_fkey'
    ) THEN
        ALTER TABLE public.chatbot_configs
            ADD CONSTRAINT chatbot_configs_trial_contact_id_fkey
            FOREIGN KEY (trial_contact_id)
            REFERENCES public.contacts(id)
            ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_chatbot_configs_trial_contact
    ON public.chatbot_configs(trial_contact_id)
    WHERE trial_mode_enabled = TRUE;

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260925_001', 'Single-contact live Messenger chatbot trial mode')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
