BEGIN;
CREATE FUNCTION veo_page_supply_weight(p_user uuid,p_page uuid) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM veo_ad_planning_state WHERE page_id=p_page)
 AND(SELECT bool_and(checked_at>=now()-interval '3 hours') AND sum(active_ads)=0 FROM veo_ad_planning_state WHERE page_id=p_page)
 AND NOT EXISTS(SELECT 1 FROM veo_order_facts WHERE seller_id=p_user AND page_id=p_page AND paid_minor>0 AND done_at IS NULL) THEN 0 ELSE 1 END
$$;
DO $migration$ DECLARE definition text;previous text;BEGIN
 definition:=replace(pg_get_functiondef('veo_page_capacity(uuid,date)'::regprocedure),E'\r\n',E'\n');
 previous:=$old$CASE WHEN sum(coalesce(pw.weight,1)) OVER(PARTITION BY w.user_id)=0 THEN w.target::numeric/count(*) OVER(PARTITION BY w.user_id)
 ELSE coalesce(pw.weight,1)::numeric/sum(coalesce(pw.weight,1)) OVER(PARTITION BY w.user_id)*w.target END AS raw_target$old$;
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Expected Page operating allocation is missing';END IF;
 definition:=replace(definition,previous,$new$CASE WHEN sum(coalesce(pw.weight,1)*veo_page_supply_weight(w.user_id,up.page_id)) OVER(PARTITION BY w.user_id)=0
 THEN w.target::numeric/count(*) OVER(PARTITION BY w.user_id)
 ELSE(coalesce(pw.weight,1)*veo_page_supply_weight(w.user_id,up.page_id))::numeric/sum(coalesce(pw.weight,1)*veo_page_supply_weight(w.user_id,up.page_id)) OVER(PARTITION BY w.user_id)*w.target END AS raw_target$new$);
 previous:=$old$CASE WHEN sum(coalesce(pw.weight,1)) OVER(PARTITION BY w.user_id)=0 THEN w.production_target::numeric/count(*) OVER(PARTITION BY w.user_id) ELSE coalesce(pw.weight,1)::numeric/sum(coalesce(pw.weight,1)) OVER(PARTITION BY w.user_id)*w.production_target END AS raw_capacity$old$;
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Expected Page production allocation is missing';END IF;
 definition:=replace(definition,previous,$new$CASE WHEN sum(coalesce(pw.weight,1)*veo_page_supply_weight(w.user_id,up.page_id)) OVER(PARTITION BY w.user_id)=0 THEN w.production_target::numeric/count(*) OVER(PARTITION BY w.user_id)
 ELSE(coalesce(pw.weight,1)*veo_page_supply_weight(w.user_id,up.page_id))::numeric/sum(coalesce(pw.weight,1)*veo_page_supply_weight(w.user_id,up.page_id)) OVER(PARTITION BY w.user_id)*w.production_target END AS raw_capacity$new$);
 EXECUTE definition;
END $migration$;
REVOKE ALL ON FUNCTION veo_page_supply_weight(uuid,uuid) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION veo_page_supply_weight(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
