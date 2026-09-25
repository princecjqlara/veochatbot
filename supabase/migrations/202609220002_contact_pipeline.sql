ALTER TABLE public.contacts
    ADD COLUMN IF NOT EXISTS pipeline_stage TEXT NOT NULL DEFAULT 'new',
    ADD COLUMN IF NOT EXISTS pipeline_stage_source TEXT NOT NULL DEFAULT 'system',
    ADD COLUMN IF NOT EXISTS pipeline_stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'contacts_pipeline_stage_check'
    ) THEN
        ALTER TABLE public.contacts ADD CONSTRAINT contacts_pipeline_stage_check
            CHECK (pipeline_stage IN (
                'new', 'engaged', 'collecting_details', 'qualified',
                'order_created', 'converted', 'not_qualified', 'opted_out'
            ));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'contacts_pipeline_stage_source_check'
    ) THEN
        ALTER TABLE public.contacts ADD CONSTRAINT contacts_pipeline_stage_source_check
            CHECK (pipeline_stage_source IN ('system', 'chatbot', 'messenger', 'manual'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_contacts_page_pipeline_stage
    ON public.contacts (page_id, pipeline_stage, pipeline_stage_updated_at DESC);

UPDATE public.contacts AS contact
SET
    pipeline_stage = CASE
        WHEN state.stop_reason = 'converted' THEN 'converted'
        WHEN state.stop_reason = 'order_created' THEN 'order_created'
        WHEN state.stop_reason IN ('qualified', 'details_collected') THEN 'qualified'
        WHEN state.stop_reason IN ('not_qualified', 'refusal') THEN 'not_qualified'
        WHEN state.stop_reason = 'opt_out' THEN 'opted_out'
        WHEN state.status = 'active' AND COALESCE(state.collected_details, '{}'::jsonb) <> '{}'::jsonb THEN 'collecting_details'
        WHEN state.status = 'active' THEN 'engaged'
        ELSE contact.pipeline_stage
    END,
    pipeline_stage_source = 'chatbot',
    pipeline_stage_updated_at = COALESCE(state.updated_at, NOW())
FROM public.chatbot_contact_states AS state
WHERE state.contact_id = contact.id
  AND state.page_id = contact.page_id
  AND contact.pipeline_stage = 'new';

-- The protected Page default tag is assigned by the Messenger lead-stage worker
-- for positive lead outcomes. Historical assignments do not retain which of the
-- positive signals fired, so Qualified is the safest non-regressive backfill.
UPDATE public.contacts AS contact
SET
    pipeline_stage = 'qualified',
    pipeline_stage_source = 'messenger',
    pipeline_stage_updated_at = COALESCE((
        SELECT MAX(contact_tag.created_at)
        FROM public.contact_tags AS contact_tag
        JOIN public.tags AS tag ON tag.id = contact_tag.tag_id
        WHERE contact_tag.contact_id = contact.id
          AND tag.is_default = TRUE
          AND tag.owner_type = 'page'
          AND tag.owner_id = contact.page_id
    ), NOW())
WHERE contact.pipeline_stage = 'new'
  AND EXISTS (
      SELECT 1
      FROM public.contact_tags AS contact_tag
      JOIN public.tags AS tag ON tag.id = contact_tag.tag_id
      WHERE contact_tag.contact_id = contact.id
        AND tag.is_default = TRUE
        AND tag.owner_type = 'page'
        AND tag.owner_id = contact.page_id
  );

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260922_002', 'Add shared contact pipeline with automatic chatbot and Messenger stages')
ON CONFLICT (version) DO NOTHING;
