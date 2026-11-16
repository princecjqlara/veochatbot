BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- These endpoints are reports. Reuse verified salary snapshots instead of
-- taking quota locks whenever someone changes a filter or opens a calendar.
DO $migration$
DECLARE fn record;definition text;needle text;n integer:=0;
BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace
 AND(proname LIKE 'veo_operations%' OR proname LIKE 'veo_calendar_finance%') AND strpos(prosrc,'veo_finance_days(')>0 LOOP
  definition:=pg_get_functiondef(fn.signature);n:=n+1;
  EXECUTE replace(definition,'veo_finance_days(','veo_salary_report(');
 END LOOP;
 IF n<2 THEN RAISE EXCEPTION 'Finance reporting integration points changed';END IF;
 definition:=pg_get_functiondef('public.veo_maintenance()'::regprocedure);
 needle:=' PERFORM veo_target(a.user_id,veo_today());';
 IF strpos(definition,needle)=0 OR strpos(definition,'LIMIT 100 FOR UPDATE OF q SKIP LOCKED')=0 THEN RAISE EXCEPTION 'Salary maintenance integration point changed';END IF;
 definition:=replace(definition,needle,' -- Current-day quotas are refreshed independently in per-worker transactions.');
 definition:=replace(definition,'LIMIT 100 FOR UPDATE OF q SKIP LOCKED','LIMIT 10 FOR UPDATE OF q SKIP LOCKED');
 EXECUTE definition;
 definition:=pg_get_functiondef('public.veo_operations_maintenance()'::regprocedure);
 needle:='DECLARE cleared integer; tenant record; BEGIN';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Operations maintenance integration point changed';END IF;
 definition:=replace(definition,needle,$patch$DECLARE previous_setting text:=current_setting('veo.prepared_calendar',true);cleared integer; tenant record; BEGIN
 PERFORM set_config('veo.prepared_calendar','on',true);$patch$);
 definition:=replace(definition,' RETURN jsonb_build_object(',$patch$ PERFORM set_config('veo.prepared_calendar',coalesce(previous_setting,'off'),true);
 RETURN jsonb_build_object($patch$);
 EXECUTE definition;
END $migration$;
ALTER FUNCTION public.veo_maintenance() SET statement_timeout='5s';
ALTER FUNCTION public.veo_maintenance() SET lock_timeout='1s';
ALTER FUNCTION public.veo_operations_maintenance() SET statement_timeout='5s';
ALTER FUNCTION public.veo_operations_maintenance() SET lock_timeout='1s';

ALTER TABLE public.veo_background_job_leases DROP CONSTRAINT veo_background_job_leases_job_check;
ALTER TABLE public.veo_background_job_leases ADD CONSTRAINT veo_background_job_leases_job_check CHECK(job IN('workspace','contact-profiles','workspace-events','quotas'));
DO $migration$
DECLARE definition text;needle text:='p_job NOT IN(''workspace'',''contact-profiles'',''workspace-events'')';
BEGIN
 definition:=pg_get_functiondef('public.veo_claim_background_job(text,uuid)'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Background coordination integration point changed';END IF;
 definition:=replace(definition,needle,'p_job NOT IN(''workspace'',''contact-profiles'',''workspace-events'',''quotas'')');
 definition:=replace(definition,'clock_timestamp()+interval ''330 seconds''','clock_timestamp()+CASE WHEN p_job=''quotas'' THEN interval ''90 seconds'' ELSE interval ''330 seconds'' END');
 EXECUTE definition;
END $migration$;

CREATE TABLE public.veo_quota_refresh_state(
 user_id uuid PRIMARY KEY REFERENCES public.veo_accounts(user_id) ON DELETE CASCADE,
 last_success_at timestamptz,last_work_date date,last_attempt_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,last_error_code text
);
ALTER TABLE public.veo_quota_refresh_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.veo_quota_refresh_state FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.veo_quota_refresh_state TO service_role;
CREATE FUNCTION public.veo_claim_quota_refresh(p_limit integer DEFAULT 4) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='3s' SET lock_timeout='1s' AS $$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'Invalid quota refresh batch';END IF;
 INSERT INTO public.veo_quota_refresh_state(user_id)
 SELECT a.user_id FROM public.veo_accounts a JOIN public.users u ON u.id=a.user_id AND u.is_active
 JOIN public.veo_tenants t ON t.id=a.tenant_id AND t.launch_at IS NOT NULL
 WHERE a.active AND a.departed_at IS NULL AND a.role IN('member','manager') ON CONFLICT DO NOTHING;
 WITH due AS(
  SELECT s.user_id FROM public.veo_quota_refresh_state s JOIN public.veo_accounts a ON a.user_id=s.user_id
  JOIN public.users u ON u.id=a.user_id AND u.is_active
  WHERE a.active AND a.departed_at IS NULL AND a.role IN('member','manager')
  AND(s.next_attempt_at<=clock_timestamp() OR(s.last_error_code IS NULL AND s.last_work_date IS DISTINCT FROM public.veo_today()))
  AND(s.lease_until IS NULL OR s.lease_until<=clock_timestamp())
  ORDER BY s.last_success_at NULLS FIRST,s.last_attempt_at NULLS FIRST,s.user_id LIMIT p_limit FOR UPDATE OF s SKIP LOCKED
 ), claimed AS(
  UPDATE public.veo_quota_refresh_state s SET last_attempt_at=clock_timestamp(),lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '45 seconds'
  FROM due WHERE s.user_id=due.user_id RETURNING s.user_id,s.lease_token
 ) SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') INTO result FROM claimed c;
 RETURN result;
END $$;
CREATE FUNCTION public.veo_refresh_worker_quota(p_user uuid,p_lease uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET jit=off SET statement_timeout='5s' SET lock_timeout='1s' AS $$
DECLARE state veo_quota_refresh_state;target integer;err text;previous_setting text:=current_setting('veo.prepared_calendar',true);
BEGIN
 PERFORM set_config('veo.prepared_calendar','off',true);
 SELECT * INTO state FROM public.veo_quota_refresh_state WHERE user_id=p_user AND lease_token=p_lease AND lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Quota refresh lease lost' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.veo_accounts a JOIN public.users u ON u.id=a.user_id AND u.is_active
  WHERE a.user_id=p_user AND a.active AND a.departed_at IS NULL AND a.role IN('member','manager')) THEN
  UPDATE public.veo_quota_refresh_state SET lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE user_id=p_user;
  PERFORM set_config('veo.prepared_calendar',coalesce(previous_setting,'off'),true);
  RETURN jsonb_build_object('ok',true,'skipped',true);
 END IF;
 BEGIN
  target:=public.veo_target(p_user,public.veo_today());
 EXCEPTION WHEN query_canceled THEN
  -- The worker update is rolled back by this exception block. Record a
  -- cooldown so one repeatedly slow worker cannot starve the other staff.
  UPDATE public.veo_quota_refresh_state SET lease_token=NULL,lease_until=NULL,last_error_code='57014',next_attempt_at=clock_timestamp()+interval '10 minutes' WHERE user_id=p_user;
  PERFORM set_config('veo.prepared_calendar',coalesce(previous_setting,'off'),true);
  RETURN jsonb_build_object('ok',false,'retryable',true,'overloaded',true);
 WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS err=RETURNED_SQLSTATE;
  UPDATE public.veo_quota_refresh_state SET lease_token=NULL,lease_until=NULL,last_error_code=err,next_attempt_at=clock_timestamp()+CASE WHEN err IN('55P03','53300') THEN interval '10 minutes' ELSE interval '5 minutes' END WHERE user_id=p_user;
  PERFORM set_config('veo.prepared_calendar',coalesce(previous_setting,'off'),true);
  RETURN jsonb_build_object('ok',false,'retryable',true,'overloaded',err IN('55P03','53300'));
 END;
 UPDATE public.veo_quota_refresh_state SET last_success_at=clock_timestamp(),last_work_date=public.veo_today(),last_error_code=NULL,
  lease_token=NULL,lease_until=NULL,next_attempt_at=clock_timestamp()+interval '4 minutes' WHERE user_id=p_user;
 PERFORM set_config('veo.prepared_calendar',coalesce(previous_setting,'off'),true);
 RETURN jsonb_build_object('ok',true,'target',target,'work_date',public.veo_today());
END $$;
REVOKE ALL ON FUNCTION public.veo_claim_quota_refresh(integer),public.veo_refresh_worker_quota(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_claim_quota_refresh(integer),public.veo_refresh_worker_quota(uuid,uuid) TO service_role;
CREATE FUNCTION public.veo_connection_safety() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('statement_timeout',current_setting('statement_timeout'),'idle_transaction_timeout',current_setting('idle_in_transaction_session_timeout'))
$$;
REVOKE ALL ON FUNCTION public.veo_connection_safety() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_connection_safety() TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611160007','Read-only finance reports, bounded reconciliation and independently committed quota refreshes') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
