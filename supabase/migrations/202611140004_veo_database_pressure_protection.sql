BEGIN;
SET LOCAL lock_timeout='3s';

-- Count and sort narrow IDs; hydrate only the requested page. Previously each
-- refresh materialized every name, picture and Page label, spilling to disk.
CREATE OR REPLACE FUNCTION veo_contacts_page(p_actor uuid,p_page uuid DEFAULT NULL,p_search text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET statement_timeout='8s' AS $$
DECLARE scope jsonb;result jsonb;BEGIN
 scope:=veo_scope(p_actor);
 IF scope IS NULL OR scope->>'launch_at' IS NULL OR(p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501';END IF;
 IF p_offset IS NULL OR p_limit IS NULL OR p_search IS NULL OR p_offset<0 OR p_offset>10000000 OR p_limit<1 OR p_limit>100 OR length(p_search)>200 THEN RAISE EXCEPTION 'Invalid contact filters';END IF;
 WITH eligible AS MATERIALIZED(
  SELECT c.id,c.last_interaction_at FROM contacts c
  WHERE c.page_id IN(SELECT value::uuid FROM jsonb_array_elements_text(scope->'page_ids')) AND(p_page IS NULL OR c.page_id=p_page)
  AND(p_search='' OR strpos(lower(concat_ws(' ',c.name,c.psid)),lower(p_search))>0 OR EXISTS(
   SELECT 1 FROM veo_contact_details d CROSS JOIN LATERAL jsonb_each_text(coalesce(d.fields,'{}')) f
   WHERE d.contact_id=c.id AND strpos(lower(f.value),lower(p_search))>0))
 ), selected AS MATERIALIZED(SELECT id FROM eligible ORDER BY last_interaction_at DESC NULLS LAST,id OFFSET p_offset LIMIT p_limit), hydrated AS(
  SELECT c.id,c.page_id,c.name,c.psid,c.pipeline_stage,c.profile_pic,c.last_interaction_at,p.name AS page_name
  FROM selected s JOIN contacts c ON c.id=s.id JOIN pages p ON p.id=c.page_id
 ) SELECT jsonb_build_object('items',coalesce((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.last_interaction_at DESC NULLS LAST,h.id) FROM hydrated h),'[]'),
  'total',(SELECT count(*) FROM eligible),'offset',p_offset,'limit',p_limit) INTO result;
 RETURN result;
END $$;

ALTER TABLE app_private.veo_storage_state ADD COLUMN resource_metrics jsonb NOT NULL DEFAULT '{}',ADD COLUMN resource_metrics_at timestamptz,ADD COLUMN resource_paused_until timestamptz;
ALTER FUNCTION veo_storage_status() RENAME TO veo_storage_status_before_resources;
CREATE FUNCTION veo_storage_status() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;state app_private.veo_storage_state;fresh boolean;reasons jsonb:='[]';BEGIN
 result:=veo_storage_status_before_resources();SELECT * INTO state FROM app_private.veo_storage_state WHERE singleton;
 fresh:=coalesce(state.resource_metrics_at>now()-interval '3 minutes' AND (result->>'metrics_fresh')::boolean,false);
 IF state.resource_metrics_at IS NOT NULL THEN
  IF (state.resource_metrics->>'memory_available_bytes')::numeric<greatest(33554432,(state.resource_metrics->>'memory_total_bytes')::numeric*0.10) THEN reasons:=reasons||'"low_memory"'::jsonb;END IF;
  IF (state.resource_metrics->>'swap_total_bytes')::numeric>0 AND (state.resource_metrics->>'swap_free_bytes')::numeric<(state.resource_metrics->>'swap_total_bytes')::numeric*0.30 THEN reasons:=reasons||'"high_swap"'::jsonb;END IF;
  IF (state.resource_metrics->>'load_5m')::numeric>(state.resource_metrics->>'cpu_count')::numeric*1.25 THEN reasons:=reasons||'"sustained_load"'::jsonb;END IF;
 END IF;
 IF reasons='[]' AND state.resource_paused_until>now() THEN reasons:='["recovery_cooldown"]';END IF;
 RETURN result||jsonb_build_object('resource_metrics_fresh',fresh,'resource_metrics_at',state.resource_metrics_at,'resources',state.resource_metrics,
  'resource_pressure',reasons<>'[]','resource_pressure_reasons',reasons,'resource_paused_until',state.resource_paused_until,
  'optional_work_paused',(result->>'optional_work_paused')::boolean OR NOT fresh OR reasons<>'[]');
END $$;

ALTER FUNCTION veo_record_storage_metrics(jsonb) RENAME TO veo_record_storage_metrics_before_resources;
CREATE FUNCTION veo_record_storage_metrics(p_metrics jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='5s' AS $$
DECLARE resource jsonb;key text;value numeric;pressure boolean;BEGIN
 -- The original validator records disk failures honestly. Both updates share
 -- this transaction, so invalid resource samples cannot leave partial success.
 PERFORM veo_record_storage_metrics_before_resources(p_metrics);
 IF p_metrics->>'available'='true' AND p_metrics->>'resource_metrics_available'='true' THEN
  resource:='{}';
  FOREACH key IN ARRAY ARRAY['memory_total_bytes','memory_available_bytes','swap_total_bytes','swap_free_bytes','cpu_count','load_5m'] LOOP
   IF jsonb_typeof(p_metrics->key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid resource metrics';END IF;
   value:=(p_metrics->>key)::numeric;
   IF value<0 OR value>1000000000000000 THEN RAISE EXCEPTION 'Invalid resource metrics';END IF;
   resource:=resource||jsonb_build_object(key,value);
  END LOOP;
  IF (resource->>'memory_total_bytes')::numeric<=0 OR (resource->>'cpu_count')::numeric<1 OR (resource->>'cpu_count')::numeric>1024
   OR (resource->>'memory_available_bytes')::numeric>(resource->>'memory_total_bytes')::numeric
   OR (resource->>'swap_free_bytes')::numeric>(resource->>'swap_total_bytes')::numeric THEN RAISE EXCEPTION 'Invalid resource metrics';END IF;
  pressure:=(resource->>'memory_available_bytes')::numeric<greatest(33554432,(resource->>'memory_total_bytes')::numeric*0.10)
   OR ((resource->>'swap_total_bytes')::numeric>0 AND (resource->>'swap_free_bytes')::numeric<(resource->>'swap_total_bytes')::numeric*0.30)
   OR (resource->>'load_5m')::numeric>(resource->>'cpu_count')::numeric*1.25;
  UPDATE app_private.veo_storage_state SET resource_metrics=resource,resource_metrics_at=clock_timestamp(),
   resource_paused_until=CASE WHEN pressure THEN clock_timestamp()+interval '3 minutes' ELSE resource_paused_until END WHERE singleton;
 ELSE UPDATE app_private.veo_storage_state SET resource_metrics_at=NULL WHERE singleton;END IF;
 RETURN veo_storage_status();
END $$;

-- Bound expensive API work below the application's ten-second request limit.
-- PostgREST hoists statement_timeout at transaction start (reload below).
ALTER FUNCTION veo_recover_queued_contact_identities(integer) SET statement_timeout='5s';
ALTER FUNCTION veo_claim_inquiry_history(integer) SET statement_timeout='5s';
ALTER FUNCTION veo_finish_inquiry_history(uuid,uuid,text,timestamptz,text,boolean,text) SET statement_timeout='5s';
ALTER FUNCTION veo_claim_contact_identity_pages(integer) SET statement_timeout='5s';
ALTER FUNCTION veo_seed_contact_identities(uuid,uuid,jsonb) SET statement_timeout='5s';
ALTER FUNCTION veo_refresh_spend_quotas() SET statement_timeout='8s';
ALTER FUNCTION veo_claim_background_job(text,uuid) SET statement_timeout='3s';
ALTER FUNCTION veo_storage_status() SET statement_timeout='3s';

REVOKE ALL ON FUNCTION veo_storage_status_before_resources(),veo_record_storage_metrics_before_resources(jsonb),veo_storage_status(),veo_record_storage_metrics(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_storage_status(),veo_record_storage_metrics(jsonb) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611140004','Narrow contact pagination, resource pressure monitoring and bounded optional workers') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
