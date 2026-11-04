BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.contact_profile_transcripts (
 contact_id UUID PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
 page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
 snapshot_generation INTEGER NOT NULL,
 source_cutoff_at TIMESTAMPTZ NOT NULL,
 source_sha256 TEXT NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 message_count INTEGER NOT NULL CHECK(message_count>=0),
 customer_message_count INTEGER NOT NULL DEFAULT 0 CHECK(customer_message_count>=0),
 page_message_count INTEGER NOT NULL DEFAULT 0 CHECK(page_message_count>=0),
 customer_messages_replied INTEGER NOT NULL DEFAULT 0 CHECK(customer_messages_replied>=0),
 attachment_count BIGINT NOT NULL DEFAULT 0 CHECK(attachment_count>=0),
 image_count BIGINT NOT NULL DEFAULT 0 CHECK(image_count>=0),
 messages_gzip_base64 TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_contact_profile_transcripts_page_cutoff
 ON public.contact_profile_transcripts(page_id,source_cutoff_at DESC);
ALTER TABLE public.contact_profile_transcripts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_profile_transcripts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.contact_profile_transcripts TO service_role;

INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611050002','Store complete compressed source conversations with timestamps and attachment counts')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
