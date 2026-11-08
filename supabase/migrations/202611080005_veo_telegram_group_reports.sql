BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;
ALTER FUNCTION veo_operations_report(uuid,date) RENAME TO veo_operations_report_before_groups;
CREATE FUNCTION veo_operations_report(p_tenant uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET plan_cache_mode=force_custom_plan AS $$
DECLARE result jsonb;t jsonb;l record;ids uuid[];workers jsonb;quotas jsonb;cap jsonb;closed integer;done integer;target integer;output jsonb:='[]';BEGIN
 result:=veo_operations_report_before_groups(p_tenant,p_day);
 FOR t IN SELECT value FROM jsonb_array_elements(result->'teams') LOOP
  IF NOT EXISTS(SELECT 1 FROM veo_teams WHERE id=(t->>'id')::uuid AND telegram_groups_managed) THEN output:=output||jsonb_build_array(t);CONTINUE;END IF;
  FOR l IN SELECT x.* FROM veo_team_telegram_groups x JOIN veo_telegram_groups g ON g.tenant_id=x.tenant_id AND g.chat_id=x.chat_id AND g.active WHERE x.team_id=(t->>'id')::uuid LOOP
   SELECT coalesce(array_agg(r.page_id ORDER BY r.page_id),'{}') INTO ids FROM veo_team_telegram_pages r JOIN veo_teams tm ON tm.id=r.team_id
    WHERE r.team_id=l.team_id AND r.chat_id=l.chat_id AND veo_can_page(tm.manager_id,r.page_id);
   IF cardinality(ids)=0 THEN CONTINUE;END IF;
   SELECT coalesce(jsonb_agg(w.value||jsonb_build_object(
    'pages',coalesce((SELECT jsonb_agg(p.value) FROM jsonb_array_elements(w.value->'pages') p WHERE(p.value->>'id')::uuid=ANY(ids)),'[]'),
    'clients',coalesce((SELECT jsonb_agg(c.value) FROM jsonb_array_elements(w.value->'clients') c WHERE(c.value->>'page_id')::uuid=ANY(ids)),'[]'),
    'warnings',coalesce((SELECT jsonb_agg(e.value) FROM jsonb_array_elements(w.value->'warnings') e WHERE e.value->>'page_id' IS NULL OR(e.value->>'page_id')::uuid=ANY(ids)),'[]'),
    'receipt_holds',coalesce((SELECT jsonb_agg(h.value) FROM jsonb_array_elements(w.value->'receipt_holds') h JOIN veo_receipts r ON r.id=(h.value->>'id')::uuid WHERE r.page_id=ANY(ids)),'[]'),
    'group_results',(SELECT jsonb_build_object('closed',count(*) FILTER(WHERE f.closed_date=p_day),'done',count(*) FILTER(WHERE f.done_date=p_day)) FROM veo_sales_facts f WHERE f.tenant_id=p_tenant AND f.team_id=l.team_id AND f.seller_id=(w.value->>'id')::uuid AND f.page_id=ANY(ids) AND veo_can_page(f.seller_id,f.page_id))) ORDER BY w.value->>'name'),'[]') INTO workers
    FROM jsonb_array_elements(t->'workers') w WHERE EXISTS(SELECT 1 FROM unnest(ids) p WHERE veo_can_page((w.value->>'id')::uuid,p));
   SELECT coalesce(jsonb_agg(p.value),'[]'),coalesce(sum((p.value->>'quota')::integer),0) INTO quotas,target FROM jsonb_array_elements(t->'page_quotas') p WHERE(p.value->>'page_id')::uuid=ANY(ids);
   SELECT count(*) FILTER(WHERE closed_date=p_day),count(*) FILTER(WHERE done_date=p_day) INTO closed,done FROM veo_sales_facts WHERE tenant_id=p_tenant AND team_id=l.team_id AND page_id=ANY(ids);
   cap:=coalesce(t->'capacity','{}')||jsonb_build_object('closed',closed,'done',done,'quota',jsonb_build_object('closed',target,'done',target));
   output:=output||jsonb_build_array(t||jsonb_build_object('chat_id',l.chat_id,'thread_id',l.thread_id,'group_report',true,'group_page_ids',to_jsonb(ids),'delivery_key',l.team_id::text||':'||l.chat_id::text,
    'workers',workers,'page_quotas',quotas,'capacity',cap,'access_signature',md5(coalesce(t->>'access_signature','')||l.chat_id::text||coalesce(l.thread_id::text,'')||ids::text||coalesce((SELECT jsonb_agg(jsonb_build_array(user_id,telegram_user_id,verified_at) ORDER BY user_id)::text FROM veo_telegram_memberships WHERE chat_id=l.chat_id AND tenant_id=p_tenant),'[]'))));
  END LOOP;
 END LOOP;
 RETURN result||jsonb_build_object('teams',output,'telegram_groups_version',3,'group_report_policy','Group results and clients use routed Pages; personal commission qualification and attendance remain unique per worker across all Pages.');
END $$;
REVOKE ALL ON FUNCTION veo_operations_report(uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_operations_report(uuid,date) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
