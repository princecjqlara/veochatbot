BEGIN;
ALTER FUNCTION veo_operations_report(uuid,date) RENAME TO veo_operations_report_before_warnings;
CREATE FUNCTION veo_operations_report(p_tenant uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE result jsonb;warning_data jsonb;report_teams jsonb;owner uuid;BEGIN
 result:=veo_operations_report_before_warnings(p_tenant,p_day);
 SELECT owner_id INTO owner FROM veo_tenants WHERE id=p_tenant AND launch_at IS NOT NULL;
 IF owner IS NULL THEN RAISE EXCEPTION 'Unknown workspace';END IF;
 warning_data:=veo_workflow_warnings(owner,NULL);
 SELECT coalesce(jsonb_agg(t.value||jsonb_build_object('workers',coalesce((
  SELECT jsonb_agg(w.value||jsonb_build_object(
   'warnings',coalesce((SELECT jsonb_agg(e.value ORDER BY e.value->>'key')
    FROM jsonb_array_elements(warning_data->'workers') staff CROSS JOIN LATERAL jsonb_array_elements(staff.value->'warnings') e
    WHERE staff.value->>'id'=w.value->>'id' AND(e.value->>'page_id' IS NULL OR veo_can_page((w.value->>'id')::uuid,(e.value->>'page_id')::uuid))),'[]'),
   'clients',coalesce((SELECT jsonb_agg(c.value||jsonb_build_object('work_reason',f.work_reason) ORDER BY ord)
    FROM jsonb_array_elements(w.value->'clients') WITH ORDINALITY c(value,ord)
    JOIN veo_work_facts f ON f.id=(c.value->>'order_id')::uuid AND f.tenant_id=p_tenant
    WHERE(f.seller_id=(w.value->>'id')::uuid OR f.assignee_id=(w.value->>'id')::uuid) AND veo_can_page((w.value->>'id')::uuid,f.page_id)),'[]'))
   ORDER BY w.value->>'name') FROM jsonb_array_elements(t.value->'workers') w),'[]')) ORDER BY t.value->>'name'),'[]')
 INTO report_teams FROM jsonb_array_elements(result->'teams') t;
 RETURN result||jsonb_build_object('teams',report_teams,'warnings_as_of',warning_data->'as_of','warnings_policy',warning_data->'policy','workflow_version',2);
END $$;
REVOKE ALL ON FUNCTION veo_operations_report(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_operations_report(uuid,date) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
