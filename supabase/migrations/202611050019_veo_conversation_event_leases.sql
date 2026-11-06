BEGIN;

-- Inbound messages and Page echoes for the same person share a queue lane.
-- Anonymous Page changes use their unique event key instead.
ALTER TABLE public.veo_event_inbox ADD COLUMN conversation_key text GENERATED ALWAYS AS (
 page_id::text || ':' || coalesce(nullif(CASE
  WHEN coalesce(payload#>>'{entry,0,messaging,0,sender,id}',payload#>>'{entry,0,standby,0,sender,id}')=payload#>>'{entry,0,id}'
  THEN coalesce(payload#>>'{entry,0,messaging,0,recipient,id}',payload#>>'{entry,0,standby,0,recipient,id}')
  ELSE coalesce(payload#>>'{entry,0,messaging,0,sender,id}',payload#>>'{entry,0,standby,0,sender,id}') END,''),event_key)
) STORED;
CREATE INDEX veo_events_conversation_pending ON public.veo_event_inbox(conversation_key,received_at,event_key) WHERE status<>'done';

CREATE OR REPLACE FUNCTION public.veo_claim_events(p_limit integer DEFAULT 10) RETURNS SETOF veo_event_inbox
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN
 RETURN QUERY WITH due AS(SELECT i.event_key FROM veo_event_inbox i JOIN pages p ON p.id=i.page_id AND p.veo_enabled
 WHERE (i.status='queued' OR(i.status='processing' AND i.lease_until<now())) AND i.next_attempt_at<=now()
 AND NOT EXISTS(SELECT 1 FROM veo_event_inbox earlier WHERE earlier.conversation_key=i.conversation_key
  AND earlier.status<>'done' AND (earlier.received_at,earlier.event_key)<(i.received_at,i.event_key))
 ORDER BY i.received_at,i.event_key LIMIT greatest(0,least(p_limit,20)) FOR UPDATE OF i SKIP LOCKED)
 UPDATE veo_event_inbox i SET status='processing',attempts=attempts+1,lease_until=now()+interval '5 minutes'
 FROM due WHERE i.event_key=due.event_key RETURNING i.*;
 END $$;
REVOKE ALL ON FUNCTION public.veo_claim_events(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_claim_events(integer) TO service_role;
COMMIT;
