BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE TABLE public.veo_autotag_page_state(
 page_id uuid PRIMARY KEY REFERENCES public.pages(id) ON DELETE CASCADE,
 checked_at timestamptz NOT NULL,scan_started_at timestamptz,cursor text,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),last_attempt_at timestamptz,last_success_at timestamptz,
 lease_token uuid,lease_until timestamptz,last_error text,failures integer NOT NULL DEFAULT 0,
 conversations integer NOT NULL DEFAULT 0,stage_events integer NOT NULL DEFAULT 0,repaired_tags integer NOT NULL DEFAULT 0
);
ALTER TABLE public.veo_autotag_page_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.veo_autotag_page_state FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.veo_autotag_page_state TO service_role;

CREATE FUNCTION public.veo_claim_autotag_pages(p_limit integer DEFAULT 3) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 6 THEN RAISE EXCEPTION 'Invalid Page batch';END IF;
 INSERT INTO veo_autotag_page_state(page_id,checked_at)
 SELECT p.id,t.launch_at FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id
 WHERE p.veo_enabled AND t.launch_at IS NOT NULL ON CONFLICT(page_id) DO NOTHING;
 WITH due AS(
  SELECT s.page_id FROM veo_autotag_page_state s JOIN pages p ON p.id=s.page_id JOIN veo_tenants t ON t.id=p.veo_tenant_id
  WHERE p.veo_enabled AND p.messaging_auto_tag_enabled AND t.launch_at IS NOT NULL
   AND s.next_attempt_at<=now() AND(s.lease_until IS NULL OR s.lease_until<now())
  ORDER BY s.last_attempt_at NULLS FIRST,s.page_id LIMIT p_limit FOR UPDATE OF s SKIP LOCKED
 ), claimed AS(
  UPDATE veo_autotag_page_state s SET last_attempt_at=clock_timestamp(),lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',scan_started_at=coalesce(s.scan_started_at,clock_timestamp())
  FROM due WHERE s.page_id=due.page_id RETURNING s.*
 ) SELECT coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('fb_page_id',p.fb_page_id,'access_token',p.access_token,'launch_at',t.launch_at,'owner_id',t.owner_id)),'[]') INTO result
 FROM claimed c JOIN pages p ON p.id=c.page_id JOIN veo_tenants t ON t.id=p.veo_tenant_id;
 RETURN result;
END $$;

CREATE FUNCTION public.veo_finish_autotag_page(p_page uuid,p_lease uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s veo_autotag_page_state;err text;next_cursor text;
BEGIN
 SELECT * INTO s FROM veo_autotag_page_state WHERE page_id=p_page AND lease_token=p_lease AND lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false;END IF;
 err:=nullif(p_result->>'error','');next_cursor:=nullif(p_result->>'next_cursor','');
 IF length(next_cursor)>8192 OR (err IS NOT NULL AND err !~ '^[A-Z0-9_]{1,80}$') THEN RAISE EXCEPTION 'Invalid scan checkpoint';END IF;
 UPDATE veo_autotag_page_state SET
 checked_at=CASE WHEN err IS NULL AND next_cursor IS NULL THEN greatest(checked_at,scan_started_at-interval '5 minutes') ELSE checked_at END,
 cursor=CASE WHEN err IS NULL THEN next_cursor ELSE cursor END,
 scan_started_at=CASE WHEN err IS NULL AND next_cursor IS NULL THEN NULL ELSE scan_started_at END,
 last_success_at=CASE WHEN err IS NULL THEN clock_timestamp() ELSE last_success_at END,
 last_error=err,failures=CASE WHEN err IS NULL THEN 0 ELSE failures+1 END,
 next_attempt_at=clock_timestamp()+CASE WHEN err IS NULL THEN interval '1 minute' ELSE make_interval(secs=>least(1800,30*(2^least(failures,5))::integer)) END,
 conversations=conversations+greatest(0,coalesce((p_result->>'conversations')::int,0)),
 stage_events=stage_events+greatest(0,coalesce((p_result->>'stage_events')::int,0)),
 repaired_tags=repaired_tags+greatest(0,coalesce((p_result->>'repaired_tags')::int,0)),
 lease_token=NULL,lease_until=NULL WHERE page_id=p_page;
 UPDATE pages SET messaging_auto_tag_last_error=err WHERE id=p_page;
 RETURN true;
END $$;

CREATE FUNCTION public.veo_repair_autotag_history(p_page uuid,p_limit integer DEFAULT 250) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e record;added integer;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid repair limit';END IF;
 IF NOT EXISTS(SELECT 1 FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id WHERE p.id=p_page AND p.veo_enabled AND t.launch_at IS NOT NULL) THEN RAISE EXCEPTION 'Page outside workspace';END IF;
 added:=repair_chatbot_page_outcome_tags(p_page,p_limit);
 FOR e IN SELECT DISTINCT ON (h.contact_id,stage_history_tag_key(h.label)) h.contact_id,h.label,h.stage
  FROM messenger_lead_stage_events h JOIN contacts c ON c.id=h.contact_id AND c.page_id=h.page_id
  WHERE h.page_id=p_page AND NOT EXISTS(SELECT 1 FROM tags t JOIN contact_tags ct ON ct.tag_id=t.id AND ct.contact_id=h.contact_id WHERE t.owner_id=p_page AND t.system_key=stage_history_tag_key(h.label))
  ORDER BY h.contact_id,stage_history_tag_key(h.label),h.occurred_at DESC LIMIT p_limit
 LOOP PERFORM add_contact_stage_history_tag(p_page,e.contact_id,e.label,e.stage);added:=added+1;END LOOP;
 RETURN added;
END $$;

CREATE FUNCTION public.veo_autotag_status(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;result jsonb;
BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF a.user_id IS NULL OR a.role NOT IN('owner','team_leader') THEN RAISE EXCEPTION 'Supervisor access required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('page_id',p.id,'name',p.name,'enabled',p.messaging_auto_tag_enabled,
  'last_attempt_at',s.last_attempt_at,'last_success_at',s.last_success_at,'last_error',s.last_error,
  'pending_history',s.cursor IS NOT NULL,'conversations',coalesce(s.conversations,0),'stage_events',coalesce(s.stage_events,0),'repaired_tags',coalesce(s.repaired_tags,0)) ORDER BY p.name),'[]') INTO result
 FROM pages p LEFT JOIN veo_autotag_page_state s ON s.page_id=p.id WHERE p.veo_tenant_id=a.tenant_id AND p.veo_enabled AND veo_can_page(p_actor,p.id);
 RETURN jsonb_build_object('pages',result,'checked_at',now(),'source','Saved per-Page recovery scans; Meta may omit administrative notices');
END $$;
REVOKE ALL ON FUNCTION public.veo_claim_autotag_pages(integer),public.veo_finish_autotag_page(uuid,uuid,jsonb),public.veo_repair_autotag_history(uuid,integer),public.veo_autotag_status(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_claim_autotag_pages(integer),public.veo_finish_autotag_page(uuid,uuid,jsonb),public.veo_repair_autotag_history(uuid,integer),public.veo_autotag_status(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
