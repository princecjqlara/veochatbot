BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
-- Seeding contact identities must not queue old conversations or manufacture
-- historical stage events. Live webhook writes retain their normal triggers.
DO $$
DECLARE signature text;definition text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.veo_queue_contact_source()','public.record_ad_lead_stage_event()'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  IF strpos(definition,'app.veo_contact_identity_seed')=0 THEN
   definition:=regexp_replace(definition,'\mBEGIN\M',$guard$BEGIN
    IF TG_OP='INSERT' AND current_setting('app.veo_contact_identity_seed',true)='true' THEN RETURN NEW;END IF;
   $guard$);
   IF strpos(definition,'app.veo_contact_identity_seed')=0 THEN RAISE EXCEPTION 'Expected contact trigger body missing';END IF;
   EXECUTE definition;
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION public.veo_seed_contact_identities(p_actor uuid,p_page uuid,p_contacts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE inserted integer;received integer;previous_setting text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM veo_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=p_actor AND a.active AND u.is_active AND a.role='owner')
 OR NOT veo_can_page(p_actor,p_page) THEN RAISE EXCEPTION 'Owner Page access required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_contacts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_contacts)>50 THEN RAISE EXCEPTION 'At most 50 contact identities per request';END IF;
 received:=jsonb_array_length(p_contacts);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_contacts) x WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
  OR coalesce(x->>'psid','') !~ '^[0-9]{1,40}$' OR length(coalesce(x->>'name',''))>200) THEN RAISE EXCEPTION 'Invalid contact identity';END IF;
 previous_setting:=current_setting('app.veo_contact_identity_seed',true);
 PERFORM set_config('app.veo_contact_identity_seed','true',true);
 INSERT INTO contacts(page_id,psid,name)
 SELECT p_page,x->>'psid',nullif(btrim(x->>'name'),'') FROM (
  SELECT DISTINCT ON(value->>'psid') value AS x FROM jsonb_array_elements(p_contacts)
 ) identities
 ON CONFLICT(page_id,psid) DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 PERFORM set_config('app.veo_contact_identity_seed',coalesce(previous_setting,''),true);
 RETURN jsonb_build_object('received',received,'inserted',inserted,'skipped',received-inserted);
END $$;
REVOKE ALL ON FUNCTION public.veo_seed_contact_identities(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_seed_contact_identities(uuid,uuid,jsonb) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611090003','Bounded owner contact identity sync without historical messages or jobs') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
