-- Let multiple Page chatbot configs reuse one Page's knowledge and media
-- library without duplicating embeddings or large files.

BEGIN;

ALTER TABLE public.chatbot_configs
    ADD COLUMN IF NOT EXISTS knowledge_source_page_id UUID REFERENCES public.pages(id) ON DELETE SET NULL;

UPDATE public.chatbot_configs
SET knowledge_source_page_id = page_id
WHERE knowledge_source_page_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_chatbot_configs_knowledge_source_page
    ON public.chatbot_configs (knowledge_source_page_id);

INSERT INTO app_private.schema_migrations (version, description)
VALUES ('20260925_005', 'Allow Page chatbots to share one knowledge and media library')
ON CONFLICT (version) DO UPDATE
SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';

COMMIT;
