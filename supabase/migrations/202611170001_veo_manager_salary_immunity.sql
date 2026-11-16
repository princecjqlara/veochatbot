BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Managers retain workload targets for planning, but their base commission
-- never depends on reaching those targets. Keep incentive/refund accounting.
DO $migration$
DECLARE definition text;needle text;fn regprocedure;
BEGIN
 definition:=pg_get_functiondef('veo_salary_before_incentives(uuid,date)'::regprocedure);
 needle:='rate:=CASE WHEN cd>=target AND dd>=target THEN 40 ELSE 35 END;';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Manager salary integration point changed';END IF;
 definition:=replace(definition,needle,'rate:=CASE WHEN EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=p_user AND role=''manager'') OR (cd>=target AND dd>=target) THEN 40 ELSE 35 END;');
 EXECUTE definition;

 definition:=pg_get_functiondef('veo_salary(uuid,date)'::regprocedure);
 needle:='RETURN result||jsonb_build_object(''totals'',totals);';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Manager salary metadata integration point changed';END IF;
 EXECUTE replace(definition,needle,'RETURN result||jsonb_build_object(''totals'',totals,''role'',(SELECT role FROM veo_accounts WHERE user_id=p_user),''manager_immunity'',EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=p_user AND role=''manager''));');

 FOREACH fn IN ARRAY ARRAY['veo_finance_days(uuid,date,date,uuid,uuid)'::regprocedure,'veo_salary_report(uuid,date,date,uuid,uuid)'::regprocedure] LOOP
  definition:=pg_get_functiondef(fn);
  needle:='CASE WHEN coalesce(c.cd,0)>=coalesce(t.target,1) AND coalesce(c.dd,0)>=coalesce(t.target,1) THEN 40 ELSE 35 END AS rate';
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Manager finance integration point changed: %',fn;END IF;
  definition:=replace(definition,needle,'CASE WHEN w.role=''manager'' OR (coalesce(c.cd,0)>=coalesce(t.target,1) AND coalesce(c.dd,0)>=coalesce(t.target,1)) THEN 40 ELSE 35 END AS rate');
  definition:=replace(definition,'frames AS(SELECT w.user_id,w.name,w.active,','frames AS(SELECT w.user_id,w.name,w.active,w.role,');
  needle:='''rate'',f.rate,''provisional''';
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Manager finance metadata integration point changed';END IF;
  definition:=replace(definition,needle,'''rate'',f.rate,''role'',f.role,''manager_immunity'',f.role=''manager'',''provisional''');
  EXECUTE definition;
 END LOOP;

 -- The calendar apportions commission across Pages and orders. Change its
 -- rate in place so its exact rounding and optional incentives stay intact.
 definition:=rtrim(pg_get_viewdef('veo_calendar_order_values'::regclass,true),E';\n ');
 needle:='THEN 40';
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'Manager calendar rate integration point changed';END IF;
 definition:=replace(definition,needle,'THEN 40 WHEN EXISTS(SELECT 1 FROM public.veo_accounts manager_account WHERE manager_account.user_id=f.seller_id AND manager_account.role=''manager'') THEN 40');
 EXECUTE 'CREATE OR REPLACE VIEW public.veo_calendar_order_values AS '||definition;

 -- Unfinished manager targets do not become a carryover penalty.
 definition:=pg_get_functiondef('veo_supply_target(uuid,date,integer)'::regprocedure);
 needle:=' IF (policy->>''carry_enabled'')::boolean AND';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Manager carryover integration point changed';END IF;
 EXECUTE replace(definition,needle,' IF NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=p_user AND role=''manager'') AND (policy->>''carry_enabled'')::boolean AND');

 -- Keep membership observations accurate without automatically offboarding
 -- managers. Explicit supervisor actions retain their existing permissions.
 definition:=pg_get_functiondef('veo_apply_telegram_observations_core(uuid,jsonb)'::regprocedure);
 needle:='IF state IN(''left'',''kicked'')';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Manager legacy membership integration point changed';END IF;
 EXECUTE replace(definition,needle,'IF account.role<>''manager'' AND state IN(''left'',''kicked'')');
 definition:=pg_get_functiondef('veo_apply_telegram_observations(uuid,jsonb)'::regprocedure);
 needle:='IF all_count>0 AND all_count=left_count THEN';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Manager group membership integration point changed';END IF;
 EXECUTE replace(definition,needle,'IF a.role<>''manager'' AND all_count>0 AND all_count=left_count THEN');

 -- Poll penalties are exempt; receipt holds and project issues remain factual
 -- operational information and never produce automatic pay deductions.
 definition:=pg_get_functiondef('veo_workflow_warnings_before_missed_offers(uuid,uuid)'::regprocedure);
 needle:='FROM staff a WHERE a.active AND a.role<>''owner'' AND a.mapped';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Manager attendance warning integration point changed';END IF;
 EXECUTE replace(definition,needle,'FROM staff a WHERE a.active AND a.role NOT IN(''owner'',''manager'') AND a.mapped');
END $migration$;

-- Let the normal reconciliation worker audit previously calculated manager
-- salary totals. No payments, transfers or Telegram messages are created here.
INSERT INTO veo_salary_reconciliation(user_id,work_date)
 SELECT DISTINCT f.seller_id,f.done_date FROM veo_order_facts f
 JOIN veo_accounts a ON a.user_id=f.seller_id AND a.role='manager'
 WHERE f.done_date IS NOT NULL
 ON CONFLICT(user_id,work_date) DO UPDATE SET queued_at=now();

INSERT INTO app_private.schema_migrations(version,description)
 VALUES('202611170001','Fixed 40 percent manager base salary and immunity from quota carryover, attendance penalties and automatic removal') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
