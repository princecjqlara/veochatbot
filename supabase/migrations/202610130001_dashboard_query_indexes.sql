-- Match the unfiltered pipeline's Page-scoped sort so LIMIT 25 does not
-- fetch and sort every contact on the Page. Keep the stage-filter index too.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_contacts_page_pipeline_recent
    ON public.contacts (page_id, pipeline_stage_updated_at DESC, last_interaction_at DESC NULLS LAST);

-- Analytics needs only chatbot delivery events. Campaign traffic dominates
-- the general Page/sent-time index and should not be scanned for bot totals.
CREATE INDEX IF NOT EXISTS idx_outbound_chatbot_page_sent
    ON public.outbound_message_events (page_id, sent_at DESC)
    WHERE source_type = 'chatbot';

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20261013_001', 'Indexes for Page pipeline sorting and chatbot delivery analytics')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

COMMIT;
