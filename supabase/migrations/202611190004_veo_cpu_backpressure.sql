BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- React to a new CPU/run-queue spike before its five-minute average catches up.
-- Keep older monitor payloads compatible during the app deployment.
DO $migration$
DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.veo_record_storage_metrics(jsonb)'::regprocedure);
 needle:='DECLARE resource jsonb;key text;value numeric;pressure boolean;BEGIN';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Resource monitor declaration changed';END IF;
 definition:=replace(definition,needle,'DECLARE resource jsonb;key text;value numeric;pressure boolean;sample_at timestamptz:=clock_timestamp();BEGIN');
 needle:=E'  END LOOP;\n  IF (resource->>''memory_total_bytes'')';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Resource monitor validation changed';END IF;
 definition:=replace(definition,needle,$patch$  END LOOP;
  IF p_metrics ? 'load_1m' THEN
   IF jsonb_typeof(p_metrics->'load_1m') IS DISTINCT FROM 'number' OR (p_metrics->>'load_1m')::numeric NOT BETWEEN 0 AND 1000000000000000 THEN
    RAISE EXCEPTION 'Invalid one-minute load';END IF;
   resource:=resource||jsonb_build_object('load_1m',(p_metrics->>'load_1m')::numeric);
  END IF;
  IF p_metrics ? 'resource_sample_epoch' THEN
   IF jsonb_typeof(p_metrics->'resource_sample_epoch') IS DISTINCT FROM 'number' OR (p_metrics->>'resource_sample_epoch')::numeric NOT BETWEEN 1 AND 100000000000 THEN
    RAISE EXCEPTION 'Invalid resource sample time';END IF;
   sample_at:=to_timestamp((p_metrics->>'resource_sample_epoch')::double precision);
   IF sample_at>clock_timestamp()+interval '30 seconds' THEN RAISE EXCEPTION 'Resource sample time is in the future';END IF;
  END IF;
  IF (resource->>'memory_total_bytes')$patch$);
 needle:='OR (resource->>''load_5m'')::numeric>(resource->>''cpu_count'')::numeric*1.25;';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Resource pressure rule changed';END IF;
 definition:=replace(definition,needle,replace(needle,';',E'\n   OR coalesce((resource->>''load_1m'')::numeric,0)>(resource->>''cpu_count'')::numeric;'));
 needle:='resource_metrics_at=clock_timestamp(),';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Resource sample checkpoint changed';END IF;
 EXECUTE replace(definition,needle,'resource_metrics_at=sample_at,');

 definition:=pg_get_functiondef('public.veo_storage_status()'::regprocedure);
 needle:=$old$  IF (state.resource_metrics->>'load_5m')::numeric>(state.resource_metrics->>'cpu_count')::numeric*1.25 THEN reasons:=reasons||'"sustained_load"'::jsonb;END IF;$old$;
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Resource status rule changed';END IF;
 EXECUTE replace(definition,needle,needle||E'\n'||$patch$  IF coalesce((state.resource_metrics->>'load_1m')::numeric,0)>(state.resource_metrics->>'cpu_count')::numeric THEN reasons:=reasons||'"load_spike"'::jsonb;END IF;$patch$);
END $migration$;

-- Coordinate duplicate scheduled runs and both callers of the live-event drain.
ALTER TABLE public.veo_background_job_leases DROP CONSTRAINT veo_background_job_leases_job_check;
ALTER TABLE public.veo_background_job_leases ADD CONSTRAINT veo_background_job_leases_job_check
 CHECK(job IN('workspace','contact-profiles','workspace-events','quotas','chatbot','messaging-auto-tag','event-drain'));
DO $migration$
DECLARE definition text;needle text:='p_job NOT IN(''workspace'',''contact-profiles'',''workspace-events'',''quotas'',''chatbot'')';
BEGIN
 definition:=pg_get_functiondef('public.veo_claim_background_job(text,uuid)'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Background job admission changed';END IF;
 EXECUTE replace(definition,needle,'p_job NOT IN(''workspace'',''contact-profiles'',''workspace-events'',''quotas'',''chatbot'',''messaging-auto-tag'',''event-drain'')');
END $migration$;

-- Saved-tag repair was observed running for three Pages simultaneously. Admit
-- it alongside the existing maintenance/quota lock, before any repair writes.
DO $migration$
DECLARE definition text;source text;patched text;at integer;
BEGIN
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.veo_repair_autotag_history(uuid,integer)'::regprocedure;
 at:=strpos(source,'BEGIN');
 IF at=0 OR strpos(source,'veo_require_background_capacity')>0 THEN RAISE EXCEPTION 'Tag repair integration point changed';END IF;
 definition:=pg_get_functiondef('public.veo_repair_autotag_history(uuid,integer)'::regprocedure);
 patched:=overlay(source placing $guard$BEGIN
 IF (public.veo_storage_status()->>'optional_work_paused') IS DISTINCT FROM 'false' THEN
  RAISE EXCEPTION 'Saved tag repair deferred while database resources recover' USING ERRCODE='55P03';
 END IF;
 PERFORM public.veo_require_background_capacity();$guard$ from at for 5);
 EXECUTE replace(definition,source,patched);
END $migration$;
ALTER FUNCTION public.veo_repair_autotag_history(uuid,integer) SET statement_timeout='5s';
ALTER FUNCTION public.veo_repair_autotag_history(uuid,integer) SET jit=off;
NOTIFY pgrst,'reload schema';
COMMIT;
