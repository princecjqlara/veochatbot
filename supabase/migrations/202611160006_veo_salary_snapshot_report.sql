BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
-- Salary filters read the recorded quota snapshots. Replanning every employee
-- here takes shared row locks and can prevent other reports from completing.
-- Keep the original finance/planning function for existing maintenance flows.
DO $migration$
DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.veo_finance_days(uuid,date,date,uuid,uuid)'::regprocedure);
 definition:=replace(definition,'FUNCTION public.veo_finance_days(','FUNCTION public.veo_salary_report(');
 needle:=' IF veo_today() BETWEEN p_from AND p_to THEN PERFORM veo_target(user_id,veo_today()) FROM veo_accounts WHERE active AND role IN(''member'',''manager'') AND user_id IN(SELECT veo_descendants(p_actor)) AND(p_worker IS NULL OR user_id=p_worker); END IF;';
 IF strpos(definition,needle)=0 OR strpos(definition,'FUNCTION public.veo_salary_report(')=0 THEN RAISE EXCEPTION 'Salary report integration point changed';END IF;
 definition:=replace(definition,needle,$patch$ IF veo_today() BETWEEN p_from AND p_to AND EXISTS(
 SELECT 1 FROM veo_accounts a WHERE a.active AND a.role IN('member','manager') AND a.user_id IN(SELECT veo_descendants(p_actor))
 AND(p_worker IS NULL OR a.user_id=p_worker) AND NOT EXISTS(SELECT 1 FROM veo_daily_targets t WHERE t.user_id=a.user_id AND t.work_date=veo_today()))
 THEN RAISE EXCEPTION 'Today''s salary quota snapshots are still being prepared. Retry shortly or choose completed dates.' USING ERRCODE='55000';END IF;$patch$);
 -- Evaluate live Page access once per Page, then reuse it for each milestone
 -- and currency allocation without changing the worker's all-Page quota rate.
 needle:=' WITH workers AS MATERIALIZED(';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Salary authorization integration point changed';END IF;
 definition:=replace(definition,needle,' WITH allowed_pages AS MATERIALIZED(SELECT p.id FROM pages p WHERE p.veo_tenant_id=actor.tenant_id AND p.veo_enabled AND veo_can_page(p_actor,p.id)),workers AS MATERIALIZED(');
 definition:=replace(definition,'veo_can_page(p_actor,page_id)','page_id IN(SELECT id FROM allowed_pages)');
 EXECUTE definition;
END $migration$;
ALTER FUNCTION public.veo_salary_report(uuid,date,date,uuid,uuid) SET jit=off;
ALTER FUNCTION public.veo_salary_report(uuid,date,date,uuid,uuid) SET plan_cache_mode='force_custom_plan';
ALTER FUNCTION public.veo_salary_report(uuid,date,date,uuid,uuid) SET statement_timeout='15s';
REVOKE ALL ON FUNCTION public.veo_salary_report(uuid,date,date,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_salary_report(uuid,date,date,uuid,uuid) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611160006','Salary reports reuse recorded quotas without planning writes or shared target row locks') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
