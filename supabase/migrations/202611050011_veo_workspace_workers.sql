BEGIN;
CREATE FUNCTION public.veo_authorize_resources(p_actor uuid,p_refs jsonb) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE ref jsonb; pg uuid; tbl text; ident uuid; launched timestamptz; row_created timestamptz;
 BEGIN
 SELECT t.launch_at INTO launched FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id WHERE a.user_id=p_actor AND a.active;
 IF launched IS NULL OR jsonb_typeof(p_refs)<>'array' OR jsonb_array_length(p_refs)>10000 THEN RETURN false; END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(p_refs) LOOP
 BEGIN ident:=(ref->>'id')::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN false; END;
 pg:=NULL; row_created:=NULL;
 CASE ref->>'kind'
 WHEN 'page' THEN pg:=ident;
 WHEN 'contact' THEN SELECT page_id INTO pg FROM contacts WHERE id=ident;
 WHEN 'tag' THEN SELECT page_id INTO pg FROM tags WHERE id=ident;
 WHEN 'campaign' THEN SELECT page_id,created_at INTO pg,row_created FROM campaigns WHERE id=ident;
 WHEN 'export' THEN SELECT page_id,created_at INTO pg,row_created FROM conversation_export_jobs WHERE id=ident;
 WHEN 'asset' THEN SELECT page_id INTO pg FROM chatbot_media_assets WHERE id=ident;
 WHEN 'automation' THEN SELECT page_id INTO pg FROM workflow_automations WHERE id=ident;
 ELSE RETURN false;
 END CASE;
 IF pg IS NULL OR NOT veo_can_page(p_actor,pg) OR row_created<launched THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
 END $$;
CREATE FUNCTION public.veo_ingest_event(p_fb_page text,p_key text,p_at timestamptz,p_payload jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE pg uuid;
 BEGIN
 SELECT p.id INTO pg FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id
 WHERE p.fb_page_id=p_fb_page AND p.veo_enabled AND t.launch_at IS NOT NULL AND p_at>=t.launch_at;
 IF pg IS NULL THEN RETURN false; END IF;
 INSERT INTO veo_event_inbox(event_key,page_id,occurred_at,payload) VALUES(p_key,pg,p_at,p_payload) ON CONFLICT DO NOTHING;
 RETURN true;
 END $$;
CREATE FUNCTION public.veo_claim_events(p_limit integer DEFAULT 10) RETURNS SETOF veo_event_inbox
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN
 RETURN QUERY WITH due AS(SELECT i.event_key FROM veo_event_inbox i JOIN pages p ON p.id=i.page_id AND p.veo_enabled
 WHERE (i.status='queued' OR(i.status='processing' AND i.lease_until<now())) AND i.next_attempt_at<=now()
 ORDER BY i.received_at LIMIT least(p_limit,20) FOR UPDATE OF i SKIP LOCKED)
 UPDATE veo_event_inbox i SET status='processing',attempts=attempts+1,lease_until=now()+interval '5 minutes'
 FROM due WHERE i.event_key=due.event_key RETURNING i.*;
 END $$;
CREATE FUNCTION public.veo_claim_submissions() RETURNS SETOF veo_submissions
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN
 RETURN QUERY WITH due AS(SELECT id FROM veo_submissions WHERE expires_at>now() AND next_attempt_at<=now()
 AND(status='queued' OR(status='processing' AND lease_until<now())) ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED)
 UPDATE veo_submissions s SET status='processing',claim_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',attempt_count=attempt_count+1
 FROM due WHERE s.id=due.id RETURNING s.*;
 END $$;
CREATE FUNCTION public.veo_finish_submission(p_id uuid,p_claim uuid,p_status text,p_error text DEFAULT NULL) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN
 IF p_status NOT IN('queued','blocked','delivered') THEN RAISE EXCEPTION 'Invalid submission result'; END IF;
 UPDATE veo_submissions SET status=p_status,delivered_at=CASE WHEN p_status='delivered' THEN now() ELSE delivered_at END,
 last_error=p_error,claim_token=NULL,lease_until=NULL,next_attempt_at=now()+interval '2 minutes'
 WHERE id=p_id AND claim_token=p_claim AND status='processing';
 RETURN FOUND;
 END $$;
CREATE FUNCTION public.veo_send_allowed(p_fb_page text,p_actor uuid DEFAULT NULL,p_campaign uuid DEFAULT NULL) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id
 WHERE p.fb_page_id=p_fb_page AND p.veo_enabled AND t.launch_at IS NOT NULL AND veo_can_page(t.owner_id,p.id)
 AND(p_actor IS NULL OR veo_can_page(p_actor,p.id))
 AND(p_campaign IS NULL OR EXISTS(SELECT 1 FROM campaigns c WHERE c.id=p_campaign AND c.page_id=p.id
 AND c.created_at>=t.launch_at AND c.status IN('draft','scheduled','sending') AND veo_can_page(c.created_by,p.id))))
 $$;
DO $$ DECLARE obj record; BEGIN
 FOR obj IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'veo_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',obj.signature);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',obj.signature);
 END LOOP;
END $$;
COMMIT;
