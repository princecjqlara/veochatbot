BEGIN;
ALTER TABLE veo_telegram_staff_state ADD COLUMN availability jsonb;
ALTER FUNCTION veo_apply_telegram_observations(uuid,jsonb) RENAME TO veo_apply_telegram_observations_core;
DO $migration$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_apply_telegram_observations_core(uuid,jsonb)'::regprocedure);
 definition:=replace(definition,'IF old IS NULL OR (old->>''updated_at'')::timestamptz<answer_at THEN',
 'IF old IS NULL OR old->>''source'' IS DISTINCT FROM ''telegram'' OR (old->>''updated_at'')::timestamptz<answer_at THEN');
 EXECUTE definition;
END $migration$;
CREATE FUNCTION veo_apply_telegram_observations(p_tenant uuid,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;person jsonb;info jsonb;BEGIN
 result:=veo_apply_telegram_observations_core(p_tenant,p_payload);
 FOR person IN SELECT value FROM jsonb_array_elements(p_payload->'workers') LOOP
  info:=person->'availability';
  IF info->>'work_date'=(veo_today()+1)::text AND length(info::text)<4000 THEN
   UPDATE veo_telegram_staff_state s SET availability=jsonb_build_object('work_date',info->>'work_date','poll_id',info->>'poll_id',
    'telegram_message_id',info->'telegram_message_id','created_at',info->>'created_at','has_vote',info->'has_vote','poll_url',info->>'poll_url')
   WHERE s.tenant_id=p_tenant AND s.user_id=(person->>'user_id')::uuid AND s.observed_at=(person->>'observed_at')::timestamptz
   AND s.telegram_chat_id=(person->>'chat_id')::bigint AND s.telegram_user_id=(person->>'telegram_user_id')::bigint
   AND s.membership IN('member','administrator','creator','restricted_member') AND person->'membership_confirmed'='true'::jsonb AND person->'is_bot'='false'::jsonb;
  END IF;
 END LOOP;
 RETURN result;
END $$;

CREATE FUNCTION veo_workflow_warnings(p_actor uuid,p_worker uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE tenant uuid;workers jsonb;BEGIN
 SELECT tenant_id INTO tenant FROM veo_accounts WHERE user_id=p_actor AND active;
 IF tenant IS NULL OR p_worker IS NOT NULL AND p_worker NOT IN(SELECT veo_branch(p_actor)) THEN RAISE EXCEPTION 'Staff warning access denied' USING ERRCODE='42501';END IF;
 WITH staff AS MATERIALIZED(SELECT a.*,u.name,s.observed_at,s.availability,s.telegram_chat_id,s.membership,s.last_error,
 EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=a.user_id) AS mapped,
 CASE WHEN att.source='telegram' THEN att.active END AS active_tomorrow
 FROM veo_accounts a JOIN users u ON u.id=a.user_id LEFT JOIN veo_telegram_staff_state s ON s.user_id=a.user_id
 LEFT JOIN veo_attendance att ON att.user_id=a.user_id AND att.work_date=veo_today()+1
 WHERE a.tenant_id=tenant AND a.user_id IN(SELECT veo_branch(p_actor)) AND(p_worker IS NULL OR a.user_id=p_worker)),
 events AS(
 SELECT r.seller_id AS user_id,jsonb_build_object('key','receipt:'||r.id,'kind','salary_on_hold','severity','hold','title','Receipt evidence is on hold for salary',
 'receipt_id',r.id,'contact_id',r.contact_id,'page_id',r.page_id,'reasons',f.data->'salary_holds','created_at',r.created_at) AS detail
 FROM veo_receipts r JOIN staff a ON a.user_id=r.seller_id CROSS JOIN LATERAL(SELECT veo_receipt_facts(r.id) data) f
 WHERE r.tenant_id=tenant AND veo_can_page(p_actor,r.page_id) AND jsonb_array_length(f.data->'salary_holds')>0
 UNION ALL
 SELECT coalesce(o.assignee_id,o.seller_id),jsonb_build_object('key','overdue:'||o.id,'kind','overdue_without_reason','severity','warning','title','Project is overdue without an explanation',
 'order_id',o.id,'contact_id',o.contact_id,'page_id',o.page_id,'due_at',o.work_due_at,'overdue_hours',o.overdue_hours)
 FROM veo_work_facts o JOIN staff a ON a.user_id=coalesce(o.assignee_id,o.seller_id)
 WHERE o.tenant_id=tenant AND veo_can_page(p_actor,o.page_id) AND o.overdue AND(btrim(coalesce(o.work_reason,''))='' OR o.work_reason~*'^(unknown|n/?a|none|not provided|[-?]+)$')
 UNION ALL
 SELECT a.user_id,jsonb_build_object('key','availability:'||a.user_id||':'||(veo_today()+1),'kind','availability_unanswered',
 'severity',CASE WHEN now()>=greatest((veo_today()::text||'T22:00:00+08:00')::timestamptz,(a.availability->>'created_at')::timestamptz+interval '2 hours') THEN 'warning' ELSE 'attention' END,
 'title','Answer Jaucian''s active-for-tomorrow Telegram poll','work_date',veo_today()+1,'poll_url',a.availability->>'poll_url')
 FROM staff a WHERE a.active AND a.role<>'owner' AND a.mapped AND a.membership IN('member','administrator','creator','restricted_member') AND a.observed_at>=now()-interval '15 minutes'
 AND a.availability->>'work_date'=(veo_today()+1)::text AND a.availability->>'poll_id' IS NOT NULL AND a.availability->'has_vote' IS DISTINCT FROM 'true'::jsonb
 AND(a.availability->>'created_at')::timestamptz>=a.enrolled_at
 UNION ALL
 SELECT a.user_id,jsonb_build_object('key','mapping:'||a.user_id,'kind','telegram_mapping_missing','severity','attention','title','Telegram identity or team mapping needs supervisor review')
 FROM staff a WHERE a.active AND a.role<>'owner' AND NOT a.mapped)
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.user_id,'name',a.name,'role',a.role,'active',a.active,
 'active_tomorrow',a.active_tomorrow,'poll',a.availability,'telegram_checked_at',a.observed_at,
 'warnings',coalesce((SELECT jsonb_agg(e.detail ORDER BY e.detail->>'severity',e.detail->>'key') FROM events e WHERE e.user_id=a.user_id),'[]')) ORDER BY a.name,a.user_id),'[]') INTO workers FROM staff a;
 RETURN jsonb_build_object('as_of',clock_timestamp(),'work_date',veo_today(),'tomorrow',veo_today()+1,'workers',workers,
 'policy','Current warnings in your permitted branch. No automatic pay deductions. Missing poll or stale/unavailable Telegram data never establishes a missed vote. Completed projects awaiting client payment are not staff overdue.');
END $$;

ALTER FUNCTION veo_operations_report(uuid,date) RENAME TO veo_operations_report_without_holds;
CREATE FUNCTION veo_operations_report(p_tenant uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE report jsonb;teams jsonb;BEGIN
 report:=veo_operations_report_without_holds(p_tenant,p_day);
 SELECT coalesce(jsonb_agg(t.value||jsonb_build_object('workers',coalesce((SELECT jsonb_agg(w.value||jsonb_build_object('receipt_holds',
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'contact_name',f.data->>'contact_name','kind',r.receipt_kind,'reasons',f.data->'salary_holds') ORDER BY r.created_at)
 FROM veo_receipts r CROSS JOIN LATERAL(SELECT veo_receipt_facts(r.id) data) f WHERE r.tenant_id=p_tenant AND r.seller_id=(w.value->>'id')::uuid
 AND veo_can_page((w.value->>'id')::uuid,r.page_id) AND jsonb_array_length(f.data->'salary_holds')>0),'[]')) ORDER BY w.value->>'name')
 FROM jsonb_array_elements(t.value->'workers') w),'[]')) ORDER BY t.value->>'name'),'[]') INTO teams FROM jsonb_array_elements(report->'teams') t;
 RETURN report||jsonb_build_object('teams',teams,'workflow_version',1);
END $$;

-- Keep all historical declarations. Tomorrow planning reads Jaucian poll
-- declarations; the application no longer collects a separate parallel vote.
DO $migration$ DECLARE definition text;fn regprocedure;BEGIN
 FOREACH fn IN ARRAY ARRAY['veo_team_capacity(uuid,date)'::regprocedure,'veo_page_capacity(uuid,date)'::regprocedure] LOOP
  definition:=pg_get_functiondef(fn);
  definition:=replace(definition,'att.work_date=p_day','att.work_date=p_day AND(p_day<=veo_today() OR att.source=''telegram'')');
  definition:=replace(definition,'att.work_date=veo_today()+1','att.work_date=veo_today()+1 AND att.source=''telegram''');
  EXECUTE definition;
 END LOOP;
 FOREACH fn IN ARRAY ARRAY['veo_dashboard(uuid,date)'::regprocedure,'veo_jaucian_report(uuid,date)'::regprocedure] LOOP
  definition:=pg_get_functiondef(fn);
  definition:=replace(definition,'att.work_date=veo_today()+1','att.work_date=veo_today()+1 AND att.source=''telegram''');
  EXECUTE definition;
 END LOOP;
 definition:=pg_get_functiondef('veo_operations(uuid,date,date,uuid,uuid,text,text,integer)'::regprocedure);
 definition:=replace(definition,'work_date=veo_today()+1','work_date=veo_today()+1 AND source=''telegram''');EXECUTE definition;
 definition:=pg_get_functiondef('veo_operations_report_without_holds(uuid,date)'::regprocedure);
 definition:=replace(definition,'''work_due_at'',f.work_due_at','''work_due_at'',f.work_due_at,''work_reason'',f.work_reason');EXECUTE definition;
END $migration$;
DO $$ DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_workflow_warnings','veo_apply_telegram_observations','veo_apply_telegram_observations_core','veo_operations_report','veo_operations_report_without_holds') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);END LOOP;
 FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_scope','veo_dashboard','veo_operations','veo_operations_core','veo_finance_days','veo_team_capacity','veo_page_capacity','veo_receipts_page','veo_workflow_warnings','veo_operations_report') LOOP
 EXECUTE format('ALTER FUNCTION %s SET plan_cache_mode=''force_custom_plan''',fn.signature);EXECUTE format('ALTER FUNCTION %s SET jit=''off''',fn.signature);END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
