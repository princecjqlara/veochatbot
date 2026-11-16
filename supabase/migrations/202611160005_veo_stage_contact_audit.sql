BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
-- Conversation updated_time follows messages. Revisit known contacts in a
-- bounded rotation as well, so an older thread can expose a missed stage notice.
ALTER TABLE public.veo_autotag_page_state ADD COLUMN audit_cursor uuid;
ALTER TABLE public.veo_autotag_page_state ADD COLUMN audit_checked_at timestamptz;
CREATE FUNCTION public.veo_autotag_audit_contact(p_page uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s veo_autotag_page_state;result jsonb;
BEGIN
 SELECT state.* INTO s FROM public.veo_autotag_page_state state JOIN public.pages p ON p.id=state.page_id
 WHERE state.page_id=p_page AND state.lease_token=p_lease AND state.lease_until>now() AND p.veo_enabled AND p.messaging_auto_tag_enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'Scan lease lost';END IF;
 SELECT jsonb_build_object('id',c.id,'psid',c.psid) INTO result FROM public.contacts c
 WHERE c.page_id=p_page AND c.psid IS NOT NULL AND (s.audit_cursor IS NULL OR c.id>s.audit_cursor) ORDER BY c.id LIMIT 1;
 IF result IS NULL AND s.audit_cursor IS NOT NULL THEN
  SELECT jsonb_build_object('id',c.id,'psid',c.psid) INTO result FROM public.contacts c WHERE c.page_id=p_page AND c.psid IS NOT NULL ORDER BY c.id LIMIT 1;
 END IF;
 RETURN result;
END $$;
DO $migration$
DECLARE definition text;needle text:='lease_token=NULL,lease_until=NULL WHERE page_id=p_page;';
BEGIN
 definition:=pg_get_functiondef('public.veo_finish_autotag_page(uuid,uuid,jsonb)'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Auto-tag checkpoint definition changed';END IF;
 definition:=replace(definition,needle,$patch$audit_cursor=CASE WHEN err IS NULL AND EXISTS(SELECT 1 FROM contacts c WHERE c.id=(p_result->>'audit_contact')::uuid AND c.page_id=p_page) THEN (p_result->>'audit_contact')::uuid ELSE audit_cursor END,
 audit_checked_at=CASE WHEN err IS NULL AND p_result->>'audit_contact' IS NOT NULL THEN clock_timestamp() ELSE audit_checked_at END,
 lease_token=NULL,lease_until=NULL WHERE page_id=p_page;$patch$);
 EXECUTE definition;
END $migration$;
REVOKE ALL ON FUNCTION public.veo_autotag_audit_contact(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_autotag_audit_contact(uuid,uuid) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611160005','Rotate known-contact stage reads independently of conversation message checkpoints') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
