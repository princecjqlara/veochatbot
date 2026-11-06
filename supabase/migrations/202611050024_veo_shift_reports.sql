BEGIN;
CREATE FUNCTION veo_operations_report(p_tenant uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE result jsonb; teams jsonb; owner uuid; pages jsonb;
 BEGIN
 SELECT owner_id INTO owner FROM veo_tenants WHERE id=p_tenant AND launch_at IS NOT NULL;
 IF owner IS NULL THEN RAISE EXCEPTION 'Unknown workspace'; END IF;
 result:=veo_jaucian_report(p_tenant,p_day);
 pages:=veo_page_capacity(owner,p_day);
 SELECT coalesce(jsonb_agg(t.value||jsonb_build_object('access_signature',md5(jsonb_build_object('chat',t.value->'chat_id','thread',t.value->'thread_id',
 'staff',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.user_id,'telegram',m.telegram_user_id,'pages',(SELECT coalesce(jsonb_agg(p.id ORDER BY p.id),'[]') FROM pages p WHERE veo_can_page(a.user_id,p.id))) ORDER BY a.user_id),'[]')
 FROM veo_accounts a LEFT JOIN veo_worker_mappings m ON m.user_id=a.user_id WHERE a.active AND(a.user_id=(SELECT manager_id FROM veo_teams WHERE id=(t.value->>'id')::uuid) OR a.parent_id=(SELECT manager_id FROM veo_teams WHERE id=(t.value->>'id')::uuid))))::text),
 'page_quotas',coalesce((SELECT jsonb_agg(p.value) FROM jsonb_array_elements(pages->'plans') p WHERE p.value->>'team_id'=t.value->>'id'),'[]'),
 'workers',coalesce((SELECT jsonb_agg(w.value||jsonb_build_object('pages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) ORDER BY p.name) FROM pages p WHERE veo_can_page((w.value->>'id')::uuid,p.id)),'[]'),
 'clients',coalesce((SELECT jsonb_agg(jsonb_build_object('order_id',f.id,'contact_id',f.contact_id,'name',f.contact_name,'page_id',f.page_id,'page_name',f.page_name,'closed_date',f.closed_date,'done_date',f.done_date,'waiting_payment',f.waiting_payment,'overdue',f.overdue,'overdue_hours',f.overdue_hours,'work_status',f.work_status,'work_due_at',f.work_due_at)
 ORDER BY f.overdue_hours DESC,f.closed_at,f.id) FROM veo_work_facts f WHERE f.tenant_id=p_tenant AND(f.seller_id=(w.value->>'id')::uuid OR f.assignee_id=(w.value->>'id')::uuid)
 AND veo_can_page((w.value->>'id')::uuid,f.page_id) AND(f.closed_date=p_day OR f.done_date=p_day OR f.waiting_payment OR(f.closed_at IS NOT NULL AND f.work_status<>'delivered'))),'[]')) ORDER BY w.value->>'name') FROM jsonb_array_elements(t.value->'workers') w),'[]')) ORDER BY t.value->>'name'),'[]') INTO teams
 FROM jsonb_array_elements(result->'teams') t;
 RETURN result||jsonb_build_object('teams',teams,'report_version',2,'generated_at',clock_timestamp(),'telegram_sync',(SELECT to_jsonb(s)-'tenant_id' FROM veo_telegram_sync_state s WHERE tenant_id=p_tenant),
 'report_policy','Three scheduled cumulative performance snapshots per Philippine day: 08:00, 16:00, and 00:10 closeout. Salary and ad budgets stay in the role-protected application.');
 END $$;
REVOKE ALL ON FUNCTION veo_operations_report(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_operations_report(uuid,date) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
