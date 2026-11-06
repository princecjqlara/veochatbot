BEGIN;
CREATE INDEX veo_calendar_conversion_audit ON veo_audit(entity_id,created_at) WHERE action='verified_payment_conversion';
CREATE FUNCTION veo_calendar_demographic_fields(p_fields jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(jsonb_object_agg(key,value),'{}') FROM jsonb_each(CASE WHEN jsonb_typeof(p_fields)='object' THEN p_fields ELSE '{}' END)
 WHERE regexp_replace(lower(key),'[ _-]','','g') IN('age','edad','gender','sex','kasarian','city','location','province','country','industry','businesstype','businesscategory')
$$;
REVOKE ALL ON FUNCTION veo_calendar_demographic_fields(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_calendar_demographic_fields(jsonb) TO service_role;
-- Historical marketing reporting remains readable without creating historical
-- quotas, capacity, salary or new sales. Financial sources stay distinguishable.
CREATE VIEW veo_calendar_order_values AS
 WITH facts AS MATERIALIZED(SELECT f.* FROM veo_order_facts f),
 frames AS(SELECT DISTINCT f.seller_id,f.done_date,f.currency,
 CASE WHEN (SELECT count(*) FROM facts x WHERE x.seller_id=f.seller_id AND x.closed_date=f.done_date)>=coalesce(d.target,1)
 AND(SELECT count(*) FROM facts x WHERE x.seller_id=f.seller_id AND x.done_date=f.done_date)>=coalesce(d.target,1) THEN 40 ELSE 35 END AS rate
 FROM facts f LEFT JOIN veo_daily_targets d ON d.user_id=f.seller_id AND d.work_date=f.done_date WHERE f.done_date IS NOT NULL),
 page_amounts AS(SELECT f.seller_id,f.done_date,f.currency,f.page_id,sum(f.paid_minor)::numeric AS gross FROM facts f WHERE f.done_date IS NOT NULL GROUP BY f.seller_id,f.done_date,f.currency,f.page_id),
 page_raw AS(SELECT m.*,s.rate,floor(sum(gross) OVER(PARTITION BY m.seller_id,m.done_date,m.currency)*s.rate/100) AS total_commission,
 sum(gross) OVER(PARTITION BY m.seller_id,m.done_date,m.currency) AS total_gross FROM page_amounts m JOIN frames s USING(seller_id,done_date,currency)),
 page_share AS(SELECT *,CASE WHEN total_gross=0 THEN 0 ELSE total_commission*gross/total_gross END AS raw FROM page_raw),
 page_final AS(SELECT *,floor(raw)+CASE WHEN row_number() OVER(PARTITION BY seller_id,done_date,currency ORDER BY raw-floor(raw) DESC,page_id)
 <=total_commission-sum(floor(raw)) OVER(PARTITION BY seller_id,done_date,currency) THEN 1 ELSE 0 END AS commission FROM page_share),
 order_share AS(SELECT f.id,f.seller_id,f.done_date,f.currency,f.page_id,p.commission,
 CASE WHEN p.gross=0 THEN 0 ELSE p.commission*f.paid_minor/p.gross END AS raw FROM facts f JOIN page_final p USING(seller_id,done_date,currency,page_id)),
 order_final AS(SELECT id,floor(raw)+CASE WHEN row_number() OVER(PARTITION BY seller_id,done_date,currency,page_id ORDER BY raw-floor(raw) DESC,id)
 <=commission-sum(floor(raw)) OVER(PARTITION BY seller_id,done_date,currency,page_id) THEN 1 ELSE 0 END AS commission FROM order_share),
 legacy_running AS(SELECT p.*,o.total_minor,sum(CASE WHEN p.kind='refund' THEN -p.amount_minor ELSE p.amount_minor END) OVER(PARTITION BY p.purchase_id ORDER BY p.occurred_at,p.verified_at,p.id) AS running
 FROM contact_verified_payments p JOIN contact_purchases o ON o.id=p.purchase_id AND o.currency=p.currency JOIN pages pg ON pg.id=p.page_id JOIN veo_tenants t ON t.id=pg.veo_tenant_id
 WHERE p.voided_at IS NULL AND p.occurred_at<t.launch_at AND p.occurred_at<=now()),
 legacy AS(SELECT purchase_id,min(occurred_at) FILTER(WHERE kind<>'refund') AS closed_at,min(occurred_at) FILTER(WHERE kind<>'refund' AND running>=total_minor) AS done_at,
 sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END)::bigint AS paid_minor FROM legacy_running GROUP BY purchase_id)
 SELECT f.id::text AS order_key,f.id,f.tenant_id,f.team_id,f.page_id,f.contact_id,f.seller_id,f.currency,f.total_minor,f.paid_minor,f.closed_at,f.done_at,f.closed_date,f.done_date,
 coalesce(s.commission,0)::bigint AS commission_minor,'workspace'::text AS financial_source FROM facts f LEFT JOIN order_final s ON s.id=f.id
 UNION ALL SELECT 'legacy:'||o.id,o.id,pg.veo_tenant_id,NULL::uuid,o.page_id,o.contact_id,o.recorded_by,o.currency,o.total_minor,coalesce(l.paid_minor,0),l.closed_at,l.done_at,
 (l.closed_at AT TIME ZONE 'Asia/Manila')::date,(l.done_at AT TIME ZONE 'Asia/Manila')::date,NULL::bigint,'retained' FROM contact_purchases o
 JOIN pages pg ON pg.id=o.page_id JOIN veo_tenants t ON t.id=pg.veo_tenant_id LEFT JOIN legacy l ON l.purchase_id=o.id WHERE o.created_at<t.launch_at;
REVOKE ALL ON veo_calendar_order_values FROM PUBLIC,anon,authenticated;
GRANT SELECT ON veo_calendar_order_values TO service_role;

CREATE FUNCTION veo_calendar_inputs(p_actor uuid,p_from date,p_to date,p_day date,p_page uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' AS $$
 DECLARE actor veo_accounts; ids uuid[]; result jsonb;
 BEGIN
 SELECT * INTO actor FROM veo_accounts WHERE user_id=p_actor AND active AND role IN('owner','team_leader');
 IF actor.user_id IS NULL OR(p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) THEN RAISE EXCEPTION 'Calendar requires Owner or Team Leader Page access' USING ERRCODE='42501'; END IF;
 IF p_to<p_from OR p_to-p_from>31 OR p_day NOT BETWEEN p_from AND p_to THEN RAISE EXCEPTION 'Choose one calendar month and a day in it'; END IF;
 SELECT array_agg(id) INTO ids FROM pages WHERE veo_can_page(p_actor,id) AND(p_page IS NULL OR id=p_page);
 IF (SELECT count(*) FROM ad_lead_cohorts WHERE page_id=ANY(ids) AND first_inquiry_at>=(p_from::timestamp AT TIME ZONE 'Asia/Manila') AND first_inquiry_at<((p_to+1)::timestamp AT TIME ZONE 'Asia/Manila'))>100000 THEN RAISE EXCEPTION 'Select one Page to complete this calendar'; END IF;
 PERFORM veo_target(user_id,veo_today()) FROM veo_accounts WHERE active AND role IN('member','manager') AND user_id IN(SELECT veo_descendants(p_actor));
 PERFORM veo_team_capacity(p_actor,veo_today()); PERFORM veo_page_capacity(p_actor,veo_today());
 WITH leads AS MATERIALIZED(SELECT c.id,c.page_id,c.name,c.psid,c.pipeline_stage AS stage,c.first_inquiry_at AS inquiry_at,c.inquiry_basis,
 CASE WHEN c.attribution_status='verified_inline' THEN c.ad_id END AS ad_id,
 least(events.converted_at,CASE WHEN c.pipeline_stage='converted' AND c.pipeline_stage_updated_at BETWEEN c.first_inquiry_at AND now() THEN c.pipeline_stage_updated_at END) AS converted_at,
 events.qualified_at FROM ad_lead_cohorts c LEFT JOIN LATERAL(
 SELECT min(at) FILTER(WHERE stage='converted') AS converted_at,min(at) FILTER(WHERE stage='qualified') AS qualified_at FROM(
 SELECT e.stage,e.occurred_at AS at FROM messenger_lead_stage_events e WHERE e.page_id=c.page_id AND e.contact_id=c.id AND e.stage IN('converted','qualified')
 UNION ALL SELECT e.stage,e.stage_timestamp FROM ad_lead_stage_events e WHERE e.page_id=c.page_id AND e.contact_id=c.id AND e.stage IN('converted','qualified')
 UNION ALL SELECT 'converted',v.created_at FROM veo_audit v WHERE v.entity_id=c.id AND v.tenant_id=actor.tenant_id AND v.action='verified_payment_conversion') history
 WHERE at>=c.first_inquiry_at AND at<=now()) events ON TRUE
 WHERE c.page_id=ANY(ids) AND c.first_inquiry_at>=(p_from::timestamp AT TIME ZONE 'Asia/Manila') AND c.first_inquiry_at<least(((p_to+1)::timestamp AT TIME ZONE 'Asia/Manila'),now())),
 orders AS MATERIALIZED(SELECT o.* FROM veo_calendar_order_values o WHERE o.tenant_id=actor.tenant_id AND o.page_id=ANY(ids)
 AND(actor.role='owner' OR o.seller_id IN(SELECT veo_branch(p_actor)))
 AND(o.contact_id IN(SELECT id FROM leads) OR o.closed_date BETWEEN p_from AND p_to OR o.done_date BETWEEN p_from AND p_to)),
 cash AS(SELECT o.contact_id,o.page_id,o.currency,(p.occurred_at AT TIME ZONE 'Asia/Manila')::date AS paid_day,
 sum(CASE WHEN p.kind='refund' THEN -p.amount_minor ELSE p.amount_minor END)::bigint AS amount_minor,'workspace' AS source
 FROM veo_payments p JOIN veo_orders o ON o.id=p.order_id WHERE o.tenant_id=actor.tenant_id AND o.page_id=ANY(ids) AND o.seller_id IN(SELECT veo_branch(p_actor))
 AND(o.contact_id IN(SELECT id FROM leads) OR (p.occurred_at AT TIME ZONE 'Asia/Manila')::date BETWEEN p_from AND p_to) AND p.occurred_at<=now() GROUP BY o.contact_id,o.page_id,o.currency,paid_day
 UNION ALL SELECT p.contact_id,p.page_id,p.currency,(p.occurred_at AT TIME ZONE 'Asia/Manila')::date,
 sum(CASE WHEN p.kind='refund' THEN -p.amount_minor ELSE p.amount_minor END)::bigint,'retained'
 FROM contact_verified_payments p JOIN pages pg ON pg.id=p.page_id JOIN veo_tenants t ON t.id=pg.veo_tenant_id
 WHERE p.page_id=ANY(ids) AND p.voided_at IS NULL AND p.occurred_at<t.launch_at AND p.occurred_at<=now() AND(actor.role='owner' OR p.verified_by IN(SELECT veo_branch(p_actor)))
 AND(p.contact_id IN(SELECT id FROM leads) OR(p.occurred_at AT TIME ZONE 'Asia/Manila')::date BETWEEN p_from AND p_to) GROUP BY p.contact_id,p.page_id,p.currency,(p.occurred_at AT TIME ZONE 'Asia/Manila')::date),
 selected AS MATERIALIZED(SELECT l.*,veo_calendar_demographic_fields(d.fields) AS manual_fields,veo_calendar_demographic_fields(s.collected_details) AS saved_fields,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('field',a->>'field','value',a->>'value','evidence',a->'evidence')),'[]') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(profile.payload->'extracted_answers')='array' THEN profile.payload->'extracted_answers' ELSE '[]' END) a
 WHERE regexp_replace(lower(a->>'field'),'[ _-]','','g') IN('age','edad','gender','sex','kasarian','city','location','province','country','industry','businesstype','businesscategory')) AS extracted_answers,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('value',left(f->>'value',200),'evidence',jsonb_build_array(jsonb_build_object('message_id',f#>>'{evidence,0,message_id}')))),'[]')
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(profile.payload->'facts')='array' THEN profile.payload->'facts' ELSE '[]' END) f WHERE f->>'category'='objection' AND f#>>'{evidence,0,message_id}' IS NOT NULL) AS objections,
 profile.source_cutoff_at AS profile_as_of,m.customer_message_count,m.customer_messages_replied,m.complete_history,m.source_cutoff_at AS message_history_as_of
 FROM leads l LEFT JOIN veo_contact_details d ON d.contact_id=l.id LEFT JOIN chatbot_contact_states s ON s.contact_id=l.id AND s.page_id=l.page_id
 LEFT JOIN contact_conversation_metrics m ON m.contact_id=l.id AND m.page_id=l.page_id
 LEFT JOIN LATERAL(SELECT payload,source_cutoff_at FROM contact_profile_snapshots WHERE contact_id=l.id AND page_id=l.page_id ORDER BY generation DESC LIMIT 1) profile ON TRUE
 WHERE(l.inquiry_at AT TIME ZONE 'Asia/Manila')::date=p_day),
 peer AS(SELECT c.id,c.first_inquiry_at,least(events.at,CASE WHEN c.pipeline_stage='converted' AND c.pipeline_stage_updated_at BETWEEN c.first_inquiry_at AND now() THEN c.pipeline_stage_updated_at END) AS converted_at
 FROM ad_lead_cohorts c JOIN contact_conversation_metrics m ON m.contact_id=c.id AND m.page_id=c.page_id AND m.complete_history AND m.source_cutoff_at>=c.first_inquiry_at+interval '30 days'
 LEFT JOIN LATERAL(SELECT min(at) AS at FROM(SELECT occurred_at AS at FROM messenger_lead_stage_events WHERE contact_id=c.id AND page_id=c.page_id AND stage='converted'
 UNION ALL SELECT stage_timestamp FROM ad_lead_stage_events WHERE contact_id=c.id AND page_id=c.page_id AND stage='converted') e WHERE at>=c.first_inquiry_at AND at<=now()) events ON TRUE
 WHERE c.page_id=ANY(ids) AND c.first_inquiry_at>=((p_day-120)::timestamp AT TIME ZONE 'Asia/Manila') AND c.first_inquiry_at<((p_day-30)::timestamp AT TIME ZONE 'Asia/Manila')
 AND(c.pipeline_stage<>'converted' OR events.at IS NOT NULL OR c.pipeline_stage_updated_at>=c.first_inquiry_at)),
 messages AS(SELECT(m.occurred_at AT TIME ZONE 'Asia/Manila')::date AS day,count(*) AS inbound,
 count(*) FILTER(WHERE EXISTS(SELECT 1 FROM veo_calendar_messages r WHERE r.page_id=m.page_id AND r.client_psid=m.client_psid AND r.direction='out' AND r.occurred_at>=m.occurred_at
 AND r.occurred_at<(((m.occurred_at AT TIME ZONE 'Asia/Manila')::date+1)::timestamp AT TIME ZONE 'Asia/Manila'))) AS answered
 FROM veo_calendar_messages m WHERE m.page_id=ANY(ids) AND m.direction='in' AND m.occurred_at>=(p_from::timestamp AT TIME ZONE 'Asia/Manila') AND m.occurred_at<least(((p_to+1)::timestamp AT TIME ZONE 'Asia/Manila'),now()) GROUP BY day)
 SELECT jsonb_build_object('as_of',statement_timestamp(),'scope',veo_scope(p_actor),'selected_day',p_day,
 'leads',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY inquiry_at,id) FROM leads l),'[]'),
 'selected_clients',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY inquiry_at,id) FROM selected s),'[]'),
 'orders',coalesce((SELECT jsonb_agg(to_jsonb(o)) FROM orders o),'[]'),'cash',coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM cash c),'[]'),
 'peer_lag_hours',coalesce((SELECT jsonb_agg(CASE WHEN converted_at IS NOT NULL THEN extract(epoch FROM converted_at-first_inquiry_at)/3600 ELSE NULL END) FROM peer),'[]'),
 'messages',coalesce((SELECT jsonb_agg(to_jsonb(m)) FROM messages m),'[]'),
 'message_coverage',coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM veo_calendar_message_coverage c WHERE c.page_id=ANY(ids)),'[]'),
 'spend',coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM(SELECT page_id,spend_date,currency,
 CASE WHEN bool_and(pht_aligned) AND count(*)=count(DISTINCT ad_id) THEN sum(amount)*100 END AS amount_minor,
 bool_and(pht_aligned AND report_complete) AND count(*)=count(DISTINCT ad_id) AS complete,count(*) AS records,max(checked_at) AS checked_at
 FROM ad_daily_spend WHERE page_id=ANY(ids) AND spend_date BETWEEN p_from AND p_to GROUP BY page_id,spend_date,currency) s),'[]'),
 'page_plans',coalesce((SELECT jsonb_agg(plan||jsonb_build_object('work_date',work_date)) FROM veo_page_daily_capacity WHERE tenant_id=actor.tenant_id AND page_id=ANY(ids) AND work_date BETWEEN p_from AND p_to AND team_id IN(SELECT id FROM veo_teams WHERE manager_id IN(SELECT veo_branch(p_actor)))),'[]'),
 'team_plans',coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM veo_team_daily_capacity c JOIN veo_teams t ON t.id=c.team_id WHERE t.tenant_id=actor.tenant_id AND t.manager_id IN(SELECT veo_branch(p_actor)) AND c.work_date BETWEEN p_from AND p_to),'[]'),
 'employees',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.user_id,'name',u.name,'enrolled_at',a.enrolled_at,'departed_at',a.departed_at)) FROM veo_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id IN(SELECT veo_branch(p_actor)) AND a.role IN('member','manager')),'[]'),
 'pages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name)) FROM pages WHERE id=ANY(ids)),'[]'),
 'missing_inquiry_dates',(SELECT count(*) FROM ad_lead_cohorts WHERE page_id=ANY(ids) AND first_inquiry_at IS NULL)) INTO result;
 RETURN result;
 END $$;
REVOKE ALL ON FUNCTION veo_calendar_inputs(uuid,date,date,date,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_calendar_inputs(uuid,date,date,date,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
