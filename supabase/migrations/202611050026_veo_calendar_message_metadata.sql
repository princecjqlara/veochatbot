BEGIN;
-- Persist counts/timestamps, never message text or image bytes. Retiring a raw
-- webhook payload must not erase daily response reporting.
CREATE TABLE veo_calendar_messages(
 page_id uuid NOT NULL REFERENCES pages(id),message_id text NOT NULL,client_psid text NOT NULL,
 direction text NOT NULL CHECK(direction IN('in','out')),occurred_at timestamptz NOT NULL,
 source text NOT NULL CHECK(source IN('facebook','outbound')),PRIMARY KEY(page_id,message_id)
);
CREATE INDEX ON veo_calendar_messages(page_id,occurred_at);
CREATE INDEX ON veo_calendar_messages(page_id,client_psid,direction,occurred_at);
ALTER TABLE veo_calendar_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_calendar_messages FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_calendar_messages TO service_role;
CREATE TABLE veo_calendar_message_coverage(page_id uuid PRIMARY KEY REFERENCES pages(id),capture_from timestamptz NOT NULL);
ALTER TABLE veo_calendar_message_coverage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_calendar_message_coverage FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_calendar_message_coverage TO service_role;
INSERT INTO veo_calendar_message_coverage
 SELECT p.id,greatest(t.launch_at,now()-interval '7 days') FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id WHERE p.veo_enabled AND t.launch_at IS NOT NULL;
CREATE FUNCTION veo_calendar_capture_message(p_page uuid,p_at timestamptz,p_payload jsonb) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE e jsonb; m jsonb; pgid text; who text; outbound boolean;
 BEGIN
 e:=p_payload#>'{entry,0}'; pgid:=e->>'id'; m:=coalesce(e#>'{messaging,0}',e#>'{standby,0}');
 IF m#>>'{message,mid}' IS NULL OR m#>>'{message,is_deleted}'='true' OR NOT EXISTS(SELECT 1 FROM pages WHERE id=p_page AND veo_enabled) THEN RETURN; END IF;
 outbound:=m#>>'{sender,id}'=pgid;
 who:=CASE WHEN outbound THEN m#>>'{recipient,id}' ELSE m#>>'{sender,id}' END;
 IF nullif(who,'') IS NULL OR who=pgid THEN RETURN; END IF;
 INSERT INTO veo_calendar_messages VALUES(p_page,m#>>'{message,mid}',who,CASE WHEN outbound THEN 'out' ELSE 'in' END,p_at,'facebook')
 ON CONFLICT(page_id,message_id) DO UPDATE SET occurred_at=EXCLUDED.occurred_at,source='facebook' WHERE veo_calendar_messages.source='outbound';
 END $$;
CREATE FUNCTION veo_calendar_message_inserted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN PERFORM veo_calendar_capture_message(NEW.page_id,NEW.occurred_at,NEW.payload); RETURN NEW; END $$;
CREATE TRIGGER veo_calendar_message_inserted AFTER INSERT ON veo_event_inbox FOR EACH ROW EXECUTE FUNCTION veo_calendar_message_inserted();
SELECT veo_calendar_capture_message(page_id,occurred_at,payload) FROM veo_event_inbox WHERE payload<>'{}'::jsonb;
CREATE FUNCTION veo_calendar_outbound_inserted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN
 INSERT INTO veo_calendar_messages(page_id,message_id,client_psid,direction,occurred_at,source)
 SELECT NEW.page_id,NEW.message_id,c.psid,'out',NEW.sent_at,'outbound' FROM contacts c JOIN pages p ON p.id=c.page_id AND p.veo_enabled
 WHERE c.id=NEW.contact_id AND c.page_id=NEW.page_id AND nullif(c.psid,'') IS NOT NULL ON CONFLICT DO NOTHING;
 RETURN NEW; END $$;
CREATE TRIGGER veo_calendar_outbound_inserted AFTER INSERT ON outbound_message_events FOR EACH ROW EXECUTE FUNCTION veo_calendar_outbound_inserted();
INSERT INTO veo_calendar_messages
 SELECT e.page_id,e.message_id,c.psid,'out',e.sent_at,'outbound' FROM outbound_message_events e JOIN contacts c ON c.id=e.contact_id AND c.page_id=e.page_id
 JOIN veo_calendar_message_coverage v ON v.page_id=e.page_id WHERE e.sent_at>=v.capture_from AND nullif(c.psid,'') IS NOT NULL ON CONFLICT DO NOTHING;
DO $$ DECLARE fn record; BEGIN FOR fn IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_calendar_capture_message','veo_calendar_message_inserted','veo_calendar_outbound_inserted') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.sig); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.sig); END LOOP; END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
