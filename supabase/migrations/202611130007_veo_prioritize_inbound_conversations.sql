BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION veo_event_is_customer_message(p_payload jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(nullif(coalesce(p_payload#>>'{entry,0,messaging,0,message,mid}',p_payload#>>'{entry,0,standby,0,message,mid}'),'') IS NOT NULL
 AND coalesce(p_payload#>>'{entry,0,messaging,0,message,is_echo}',p_payload#>>'{entry,0,standby,0,message,is_echo}','false')<>'true'
 AND coalesce(p_payload#>>'{entry,0,messaging,0,sender,id}',p_payload#>>'{entry,0,standby,0,sender,id}') IS DISTINCT FROM p_payload#>>'{entry,0,id}',false)
$$;
CREATE INDEX veo_events_waiting_customers ON veo_event_inbox(conversation_key,received_at) WHERE status<>'done' AND veo_event_is_customer_message(payload);

CREATE OR REPLACE FUNCTION veo_claim_events(p_limit integer DEFAULT 10) RETURNS SETOF veo_event_inbox LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN QUERY WITH waiting AS MATERIALIZED(SELECT DISTINCT conversation_key FROM veo_event_inbox WHERE status<>'done' AND veo_event_is_customer_message(payload)),
 due AS(SELECT i.event_key FROM veo_event_inbox i JOIN pages p ON p.id=i.page_id AND p.veo_enabled
 LEFT JOIN waiting w ON w.conversation_key=i.conversation_key
 WHERE(i.status='queued' OR(i.status='processing' AND i.lease_until<now())) AND i.next_attempt_at<=now()
 AND NOT EXISTS(SELECT 1 FROM veo_event_inbox earlier WHERE earlier.conversation_key=i.conversation_key AND earlier.status<>'done' AND(earlier.received_at,earlier.event_key)<(i.received_at,i.event_key))
 ORDER BY(w.conversation_key IS NOT NULL) DESC,i.received_at,i.event_key LIMIT greatest(0,least(p_limit,20)) FOR UPDATE OF i SKIP LOCKED)
 UPDATE veo_event_inbox i SET status='processing',attempts=attempts+1,lease_until=now()+interval '5 minutes' FROM due WHERE i.event_key=due.event_key RETURNING i.*;
END $$;
REVOKE ALL ON FUNCTION veo_event_is_customer_message(jsonb),veo_claim_events(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_event_is_customer_message(jsonb),veo_claim_events(integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
