BEGIN;
CREATE TABLE veo_inquiry_history_jobs(
 contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,page_id uuid NOT NULL REFERENCES pages(id),
 cursor text CHECK(length(cursor)<=4000),scan_started boolean NOT NULL DEFAULT false,first_at timestamptz,first_message_id text,
 priority integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),checked_at timestamptz,
 history_complete boolean NOT NULL DEFAULT false,last_error text,lease_token uuid,lease_until timestamptz,
 CHECK((first_at IS NULL)=(first_message_id IS NULL))
);
CREATE INDEX veo_inquiry_history_due ON veo_inquiry_history_jobs(priority DESC,next_attempt_at,contact_id);
ALTER TABLE veo_inquiry_history_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_inquiry_history_jobs FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_inquiry_history_jobs TO service_role;
INSERT INTO veo_inquiry_history_jobs(contact_id,page_id,priority)
 SELECT c.id,c.page_id,CASE WHEN EXISTS(SELECT 1 FROM veo_orders o WHERE o.contact_id=c.id) THEN 100 ELSE 0 END
 FROM contacts c JOIN pages p ON p.id=c.page_id WHERE p.veo_enabled AND p.veo_tenant_id IS NOT NULL;

CREATE FUNCTION veo_queue_inquiry_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pages WHERE id=NEW.page_id AND veo_enabled AND veo_tenant_id IS NOT NULL) THEN RETURN NEW;END IF;
 INSERT INTO veo_inquiry_history_jobs(contact_id,page_id,priority) VALUES(NEW.id,NEW.page_id,10) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER veo_queue_inquiry_history AFTER INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION veo_queue_inquiry_history();
CREATE FUNCTION veo_prioritize_order_inquiry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO veo_inquiry_history_jobs(contact_id,page_id,priority) VALUES(NEW.contact_id,NEW.page_id,100)
 ON CONFLICT(contact_id) DO UPDATE SET priority=100,next_attempt_at=CASE WHEN veo_inquiry_history_jobs.history_complete THEN veo_inquiry_history_jobs.next_attempt_at ELSE least(veo_inquiry_history_jobs.next_attempt_at,now()) END;
 RETURN NEW;
END $$;
CREATE TRIGGER veo_prioritize_order_inquiry AFTER INSERT ON veo_orders FOR EACH ROW EXECUTE FUNCTION veo_prioritize_order_inquiry();

CREATE FUNCTION veo_claim_inquiry_history(p_limit integer DEFAULT 5) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE job record;BEGIN
 FOR job IN SELECT j.contact_id FROM veo_inquiry_history_jobs j JOIN pages p ON p.id=j.page_id AND p.veo_enabled
 WHERE j.next_attempt_at<=now() AND coalesce(j.lease_until,'-infinity')<now()
 ORDER BY j.priority DESC,j.next_attempt_at,j.contact_id LIMIT greatest(1,least(p_limit,10)) FOR UPDATE OF j SKIP LOCKED LOOP
  UPDATE veo_inquiry_history_jobs SET lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes' WHERE contact_id=job.contact_id;
  RETURN NEXT (SELECT jsonb_build_object('contact_id',j.contact_id,'page_id',j.page_id,'cursor',j.cursor,'scan_started',j.scan_started,'first_at',j.first_at,'first_message_id',j.first_message_id,'lease_token',j.lease_token,'psid',c.psid,'fb_page_id',p.fb_page_id,'access_token',p.access_token)
   FROM veo_inquiry_history_jobs j JOIN contacts c ON c.id=j.contact_id JOIN pages p ON p.id=j.page_id WHERE j.contact_id=job.contact_id);
 END LOOP;
END $$;

CREATE FUNCTION veo_finish_inquiry_history(p_contact uuid,p_lease uuid,p_cursor text,p_first timestamptz,p_message text,p_complete boolean,p_error text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
#variable_conflict use_variable
DECLARE j veo_inquiry_history_jobs;s ad_contact_sources;changed boolean:=false;first_at timestamptz;message_id text;failure text:=p_error;tenant uuid;BEGIN
 SELECT * INTO j FROM veo_inquiry_history_jobs WHERE contact_id=p_contact FOR UPDATE;
 IF p_lease IS NULL OR j.lease_token IS NULL OR j.lease_until IS NULL OR j.contact_id IS NULL OR j.lease_token IS DISTINCT FROM p_lease OR j.lease_until<now() THEN RETURN jsonb_build_object('saved',false);END IF;
 IF p_complete IS NULL OR p_message IS NOT NULL AND length(p_message)<1 OR (p_first IS NULL)<>(p_message IS NULL) OR p_first>now()+interval '1 minute' OR length(p_message)>200 OR length(p_cursor)>4000 OR (p_complete AND p_cursor IS NOT NULL) THEN RAISE EXCEPTION 'Invalid inquiry history checkpoint';END IF;
 first_at:=least(j.first_at,p_first);message_id:=CASE WHEN j.first_at IS NOT NULL AND(j.first_at<=p_first OR p_first IS NULL) THEN j.first_message_id ELSE p_message END;
 IF p_complete AND failure IS NULL THEN
  IF first_at IS NULL THEN failure:='No customer-authored message was found in accessible history';
  ELSE
   PERFORM pg_advisory_xact_lock(hashtextextended(p_contact::text,27001));
   SELECT * INTO s FROM ad_contact_sources WHERE contact_id=p_contact FOR UPDATE;
   IF s.first_inquiry_at IS NOT NULL AND s.first_inquiry_at<first_at AND s.first_message_id IS DISTINCT FROM message_id THEN
    failure:='An earlier saved inquiry exists outside the accessible history; original date retained';
   ELSE
    SELECT veo_tenant_id INTO tenant FROM pages WHERE id=j.page_id;
    changed:=s.first_inquiry_at IS DISTINCT FROM first_at OR s.first_message_id IS DISTINCT FROM message_id OR s.inquiry_basis IS DISTINCT FROM 'verified_history';
    INSERT INTO ad_contact_sources AS old(contact_id,page_id,first_inquiry_at,first_message_id,inquiry_basis)
    VALUES(p_contact,j.page_id,first_at,message_id,'verified_history')
    ON CONFLICT(contact_id) DO UPDATE SET first_inquiry_at=excluded.first_inquiry_at,first_message_id=excluded.first_message_id,first_event_key=CASE WHEN old.first_message_id=excluded.first_message_id THEN old.first_event_key END,inquiry_basis='verified_history',
     origin_ad_id=CASE WHEN old.first_message_id=excluded.first_message_id THEN old.origin_ad_id END,
     origin_evidence_key=CASE WHEN old.first_message_id=excluded.first_message_id THEN old.origin_evidence_key END,
     attribution_status=CASE WHEN old.first_message_id=excluded.first_message_id THEN old.attribution_status ELSE 'unknown' END,updated_at=now();
    UPDATE contacts SET first_interaction_at=first_at WHERE id=p_contact AND first_interaction_at IS DISTINCT FROM first_at;
    IF changed THEN INSERT INTO veo_audit(tenant_id,action,entity_id,before_value,after_value,reason)
     VALUES(tenant,'inquiry_history_verified',p_contact,jsonb_build_object('first_inquiry_at',s.first_inquiry_at,'basis',s.inquiry_basis,'first_message_id',s.first_message_id),
      jsonb_build_object('first_inquiry_at',first_at,'basis','verified_history','first_message_id',message_id),'Earliest customer message after all accessible Messenger history pages were read');END IF;
   END IF;
  END IF;
 END IF;
 UPDATE veo_inquiry_history_jobs SET cursor=CASE WHEN p_complete THEN NULL ELSE p_cursor END,scan_started=NOT p_complete AND p_cursor IS NOT NULL,
  first_at=CASE WHEN p_complete THEN NULL ELSE first_at END,first_message_id=CASE WHEN p_complete THEN NULL ELSE message_id END,
  history_complete=p_complete AND failure IS NULL,checked_at=CASE WHEN p_complete AND failure IS NULL THEN now() ELSE checked_at END,
  next_attempt_at=now()+CASE WHEN failure IS NOT NULL THEN interval '1 hour' WHEN p_complete THEN interval '7 days' ELSE interval '1 second' END,
  last_error=left(failure,500),lease_token=NULL,lease_until=NULL WHERE contact_id=p_contact;
 RETURN jsonb_build_object('saved',true,'complete',p_complete AND failure IS NULL,'changed',changed,'error',failure);
END $$;
DO $$ DECLARE f record;BEGIN FOR f IN SELECT oid::regprocedure sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_queue_inquiry_history','veo_prioritize_order_inquiry','veo_claim_inquiry_history','veo_finish_inquiry_history') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.sig);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);END LOOP;END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
