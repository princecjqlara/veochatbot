BEGIN;
-- The calendar prepares every worker first. Reuse those exact snapshots while
-- building team/Page plans in this transaction, rather than calculating each
-- worker's ad supply repeatedly under the API statement deadline.
DO $$ DECLARE definition text;needle text;BEGIN
 definition:=pg_get_functiondef('veo_target(uuid,date)'::regprocedure);
 needle:=' IF p_day<veo_today()';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Target planning integration point missing';END IF;
 definition:=replace(definition,needle,$new$ IF p_day=veo_today() AND current_setting('veo.prepared_calendar',true)='on' THEN
  SELECT greatest(1,quota) INTO result FROM veo_operating_quotas WHERE user_id=p_user AND work_date=p_day;
  IF FOUND THEN RETURN result;END IF;
 END IF;
 IF p_day<veo_today()$new$);EXECUTE definition;
 definition:=pg_get_functiondef('veo_operating_quota(uuid,date)'::regprocedure);
 needle:='CASE WHEN p_day>=veo_today()';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Operating quota integration point missing';END IF;
 definition:=replace(definition,needle,$new$CASE WHEN p_day=veo_today() AND current_setting('veo.prepared_calendar',true)='on' AND EXISTS(SELECT 1 FROM veo_operating_quotas WHERE user_id=p_user AND work_date=p_day)
 THEN (SELECT quota FROM veo_operating_quotas WHERE user_id=p_user AND work_date=p_day)
 WHEN p_day>=veo_today()$new$);EXECUTE definition;
END $$;
CREATE OR REPLACE FUNCTION veo_calendar_prepare(p_actor uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET plan_cache_mode='force_custom_plan' AS $$
DECLARE previous text:=current_setting('veo.prepared_calendar',true);BEGIN
 IF NOT EXISTS(SELECT 1 FROM veo_accounts a JOIN users u ON u.id=a.user_id AND u.is_active WHERE a.user_id=p_actor AND a.active AND a.role IN('owner','team_leader')) THEN RAISE EXCEPTION 'Calendar access denied' USING ERRCODE='42501';END IF;
 PERFORM set_config('veo.prepared_calendar','off',true);
 PERFORM veo_target(user_id,veo_today()) FROM veo_accounts WHERE active AND role IN('member','manager') AND user_id IN(SELECT veo_descendants(p_actor));
 PERFORM set_config('veo.prepared_calendar','on',true);
 PERFORM veo_team_capacity(p_actor,veo_today());
 PERFORM veo_page_capacity(p_actor,veo_today());
 PERFORM set_config('veo.prepared_calendar',coalesce(previous,'off'),true);
 RETURN true;
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('veo.prepared_calendar',coalesce(previous,'off'),true);RAISE;
END $$;
REVOKE ALL ON FUNCTION veo_calendar_prepare(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_calendar_prepare(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
