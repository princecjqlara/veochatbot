BEGIN;
-- Concurrent Page reads must not hold the same daily target/capacity row locks
-- while their historical cohort queries run. Prepare today's plan once instead.
CREATE FUNCTION veo_calendar_prepare(p_actor uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=p_actor AND active AND role IN('owner','team_leader')) THEN RAISE EXCEPTION 'Calendar access denied' USING ERRCODE='42501';END IF;
 PERFORM veo_target(user_id,veo_today()) FROM veo_accounts WHERE active AND role IN('member','manager') AND user_id IN(SELECT veo_descendants(p_actor));
 PERFORM veo_team_capacity(p_actor,veo_today()); PERFORM veo_page_capacity(p_actor,veo_today());
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION veo_calendar_prepare(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_calendar_prepare(uuid) TO service_role;
DO $$ DECLARE definition text;old_part text;BEGIN
 definition:=replace(pg_get_functiondef('veo_calendar_inputs(uuid,date,date,date,uuid)'::regprocedure),E'\r\n',E'\n');
 old_part:=$old$ PERFORM veo_target(user_id,veo_today()) FROM veo_accounts WHERE active AND role IN('member','manager') AND user_id IN(SELECT veo_descendants(p_actor));
 PERFORM veo_team_capacity(p_actor,veo_today()); PERFORM veo_page_capacity(p_actor,veo_today());$old$;
 IF strpos(definition,old_part)=0 THEN RAISE EXCEPTION 'Expected calendar planning writes are missing';END IF;
 EXECUTE replace(definition,old_part,'');
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
