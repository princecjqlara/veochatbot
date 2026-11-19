BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';

-- Coordinate whole scheduled chatbot runs across serverless instances.
ALTER TABLE public.veo_background_job_leases DROP CONSTRAINT veo_background_job_leases_job_check;
ALTER TABLE public.veo_background_job_leases ADD CONSTRAINT veo_background_job_leases_job_check
 CHECK(job IN('workspace','contact-profiles','workspace-events','quotas','chatbot'));
DO $migration$
DECLARE definition text;needle text:='p_job NOT IN(''workspace'',''contact-profiles'',''workspace-events'',''quotas'')';
BEGIN
 definition:=pg_get_functiondef('public.veo_claim_background_job(text,uuid)'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Expected background job authorization is missing';END IF;
 EXECUTE replace(definition,needle,'p_job NOT IN(''workspace'',''contact-profiles'',''workspace-events'',''quotas'',''chatbot'')');
END $migration$;

-- A SQL caller also checks pressure before the expensive continuation scan.
-- Queues and their existing eligibility/claim logic remain intact for retry.
DO $migration$
DECLARE definition text;source text;patched text;at integer;
BEGIN
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.claim_chatbot_continuation_reviews(integer,timestamptz)'::regprocedure;
 at:=strpos(source,'BEGIN');
 IF at=0 OR strpos(source,'veo_require_background_capacity')>0 THEN RAISE EXCEPTION 'Expected chatbot claim body is missing';END IF;
 definition:=pg_get_functiondef('public.claim_chatbot_continuation_reviews(integer,timestamptz)'::regprocedure);
 patched:=overlay(source placing $guard$BEGIN
 IF EXISTS(SELECT 1 FROM public.veo_tenants WHERE launch_at IS NOT NULL) THEN
  IF (public.veo_storage_status()->>'optional_work_paused') IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'Scheduled chatbot work deferred while the database recovers' USING ERRCODE='55P03';
  END IF;
  PERFORM public.veo_require_background_capacity();
 END IF;$guard$ from at for 5);
 EXECUTE replace(definition,source,patched);
END $migration$;
ALTER FUNCTION public.claim_chatbot_continuation_reviews(integer,timestamptz) SET jit=off;
NOTIFY pgrst,'reload schema';
COMMIT;
