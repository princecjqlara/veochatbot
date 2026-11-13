BEGIN;
CREATE OR REPLACE FUNCTION veo_refresh_spend_quotas() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE worker uuid;n integer:=0;head uuid;teams integer:=0;BEGIN
 FOR worker IN SELECT user_id FROM veo_accounts WHERE active AND role IN('member','manager') LOOP
  PERFORM veo_target(worker,veo_today());n:=n+1;
 END LOOP;
 FOR head IN SELECT t.owner_id FROM veo_tenants t JOIN veo_accounts a ON a.user_id=t.owner_id AND a.active JOIN users u ON u.id=a.user_id AND u.is_active WHERE t.launch_at IS NOT NULL LOOP
  PERFORM veo_team_capacity(head,veo_today());teams:=teams+1;
 END LOOP;
 RETURN jsonb_build_object('workers',n,'team_workspaces',teams,'work_date',veo_today());
END $$;

DO $$ DECLARE definition text;needle text;BEGIN
 definition:=pg_get_functiondef('veo_employee_profile_before_performance(uuid,uuid,date,date,uuid)'::regprocedure);
 needle:=' capacity:=coalesce(';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Employee capacity integration point missing';END IF;
 definition:=replace(definition,needle,' IF worker.active THEN PERFORM veo_target(p_worker,veo_today());END IF; capacity:=coalesce(');
 needle:=' WITH visible_pages AS MATERIALIZED';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Employee capacity detail integration point missing';END IF;
 definition:=replace(definition,needle,$new$ capacity:=capacity||jsonb_build_object('production_capacity',(veo_capacity(p_worker,veo_today())->>'target')::integer,'operating_quota',veo_operating_quota(p_worker,veo_today()),'quota_basis',(SELECT basis FROM veo_operating_quotas WHERE user_id=p_worker AND work_date=veo_today()),'provisional',true);
 WITH visible_pages AS MATERIALIZED$new$);
 EXECUTE definition;
END $$;
REVOKE ALL ON FUNCTION veo_refresh_spend_quotas() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_refresh_spend_quotas() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
