-- Keep preserved settings separate from the app that may run their automation.
BEGIN;
ALTER TABLE public.pages ADD COLUMN IF NOT EXISTS automation_app_id text;
CREATE INDEX IF NOT EXISTS pages_automation_app ON public.pages(automation_app_id,id);
CREATE TABLE IF NOT EXISTS app_private.veobot_runtime_policy(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),app_id text NOT NULL,enforced boolean NOT NULL DEFAULT false);
REVOKE ALL ON app_private.veobot_runtime_policy FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION app_private.veobot_page_automation_allowed(p_page_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT NOT EXISTS(SELECT 1 FROM app_private.veobot_runtime_policy WHERE enforced)
 OR EXISTS(SELECT 1 FROM public.pages p JOIN app_private.veobot_runtime_policy policy ON p.automation_app_id=policy.app_id
 WHERE policy.enforced AND p.id=p_page_id)
$$;
REVOKE ALL ON FUNCTION app_private.veobot_page_automation_allowed(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app_private.veobot_page_automation_allowed(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.get_automation_page_scope() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM app_private.veobot_runtime_policy WHERE enforced) THEN NULL::uuid[]
 ELSE ARRAY(SELECT p.id FROM public.pages p WHERE app_private.veobot_page_automation_allowed(p.id) ORDER BY p.id) END
$$;
REVOKE ALL ON FUNCTION public.get_automation_page_scope() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_automation_page_scope() TO service_role;
CREATE OR REPLACE FUNCTION public.register_automation_page_owner(p_page_id uuid,p_app_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_private.veobot_runtime_policy WHERE enforced AND app_id=p_app_id) THEN RETURN false;END IF;
 UPDATE public.pages SET automation_app_id=p_app_id WHERE id=p_page_id;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.register_automation_page_owner(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_automation_page_owner(uuid,text) TO service_role;

-- Add ownership to existing atomic claims without changing their parameters,
-- timing, eligibility, retry rules, or saved configuration.
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.claim_chatbot_inbound_recovery_pages(integer,timestamptz)'::regprocedure) INTO definition;
 IF position('app_private.veobot_page_automation_allowed' in definition)=0 THEN
  IF position('WHERE r.enabled AND cfg.enabled' in definition)=0 THEN RAISE EXCEPTION 'Unexpected inbound recovery claim definition';END IF;
  definition:=replace(definition,'WHERE r.enabled AND cfg.enabled','WHERE app_private.veobot_page_automation_allowed(r.page_id) AND r.enabled AND cfg.enabled');EXECUTE definition;
 END IF;
 SELECT pg_get_functiondef('public.claim_chatbot_continuation_reviews(integer,timestamptz)'::regprocedure) INTO definition;
 IF position('app_private.veobot_page_automation_allowed' in definition)=0 THEN
  IF position('WHERE NOT cfg.commercial_video_intake_enabled' in definition)=0 OR position('WHERE cfg.commercial_video_intake_enabled' in definition)=0
   OR position('WHERE status=''pending'' AND due_at' in definition)=0 OR position('WHERE status=''processing'' AND claimed_at' in definition)=0 THEN
   RAISE EXCEPTION 'Unexpected continuation claim definition';END IF;
  definition:=replace(definition,'WHERE NOT cfg.commercial_video_intake_enabled','WHERE app_private.veobot_page_automation_allowed(s.page_id) AND NOT cfg.commercial_video_intake_enabled');
  definition:=replace(definition,'WHERE cfg.commercial_video_intake_enabled','WHERE app_private.veobot_page_automation_allowed(s.page_id) AND cfg.commercial_video_intake_enabled');
  definition:=replace(definition,'WHERE status=''pending'' AND due_at','WHERE app_private.veobot_page_automation_allowed(page_id) AND status=''pending'' AND due_at');
  definition:=replace(definition,'WHERE status=''processing'' AND claimed_at','WHERE app_private.veobot_page_automation_allowed(page_id) AND status=''processing'' AND claimed_at');EXECUTE definition;
 END IF;
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
