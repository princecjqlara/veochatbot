BEGIN;
CREATE TABLE IF NOT EXISTS public.chatbot_inbound_recovery_pages (
    page_id uuid PRIMARY KEY REFERENCES public.pages(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    enabled_at timestamptz NOT NULL DEFAULT now(),
    scan_cursor text,
    checked_at timestamptz,
    lease_until timestamptz,
    last_error text
);
CREATE TABLE IF NOT EXISTS public.chatbot_inbound_recovery_events (
    page_id uuid NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    message_id text NOT NULL,
    inbound_at timestamptz NOT NULL,
    status text NOT NULL CHECK(status IN ('processing','done','failed')),
    attempt_count integer NOT NULL DEFAULT 1,
    error_message text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(page_id,message_id)
);
ALTER TABLE public.chatbot_inbound_recovery_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chatbot_inbound_recovery_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chatbot_inbound_recovery_pages,public.chatbot_inbound_recovery_events FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.chatbot_inbound_recovery_pages,public.chatbot_inbound_recovery_events TO service_role;

CREATE OR REPLACE FUNCTION public.claim_chatbot_inbound_recovery_pages(p_limit integer DEFAULT 1,p_now timestamptz DEFAULT now())
RETURNS SETOF public.chatbot_inbound_recovery_pages LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
    WITH eligible AS (
        SELECT r.page_id FROM chatbot_inbound_recovery_pages r JOIN chatbot_configs cfg ON cfg.page_id=r.page_id
        WHERE r.enabled AND cfg.enabled AND (r.lease_until IS NULL OR r.lease_until<p_now)
        ORDER BY r.checked_at NULLS FIRST,r.page_id LIMIT LEAST(3,GREATEST(1,p_limit)) FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE chatbot_inbound_recovery_pages r SET lease_until=p_now+interval '3 minutes',checked_at=p_now
    FROM eligible e WHERE r.page_id=e.page_id RETURNING r.*;
$$;
REVOKE ALL ON FUNCTION public.claim_chatbot_inbound_recovery_pages(integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_chatbot_inbound_recovery_pages(integer,timestamptz) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261017_003','Opt-in recovery of recent real Messenger messages missing from webhook delivery')
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description;
NOTIFY pgrst,'reload schema';
COMMIT;
