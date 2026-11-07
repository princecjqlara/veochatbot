BEGIN;
ALTER TABLE ad_daily_spend ADD COLUMN frequency numeric CHECK(frequency>=0);
CREATE INDEX veo_creative_first_inquiry ON ad_contact_sources(page_id,origin_ad_id,first_inquiry_at,contact_id) WHERE attribution_status='verified_inline';
CREATE FUNCTION veo_creative_inputs(p_actor uuid,p_page uuid,p_from date,p_to date,p_ad text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE result jsonb;tenant uuid;actor_role text;BEGIN
 SELECT tenant_id,role INTO tenant,actor_role FROM veo_accounts WHERE user_id=p_actor AND active AND role IN('owner','team_leader');
 IF tenant IS NULL OR NOT veo_can_page(p_actor,p_page) THEN RAISE EXCEPTION 'Owner or Team Leader Page access required' USING ERRCODE='42501';END IF;
 IF p_to<p_from OR p_to-p_from>92 OR p_to>veo_today() OR p_ad IS NOT NULL AND p_ad!~'^[0-9]{1,100}$' THEN RAISE EXCEPTION 'Choose an ad and up to 93 dates';END IF;
 WITH cohort AS MATERIALIZED(SELECT c.id,c.page_id,c.name,c.pipeline_stage AS stage,s.origin_ad_id AS ad_id,s.first_inquiry_at AS inquiry_at,
 least((SELECT min(at) FROM(SELECT occurred_at AS at FROM messenger_lead_stage_events WHERE page_id=p_page AND contact_id=c.id AND stage='converted'
 UNION ALL SELECT stage_timestamp FROM ad_lead_stage_events WHERE page_id=p_page AND contact_id=c.id AND stage='converted') e WHERE at>=s.first_inquiry_at AND at<=now()),
 CASE WHEN c.pipeline_stage='converted' AND c.pipeline_stage_updated_at BETWEEN s.first_inquiry_at AND now() THEN c.pipeline_stage_updated_at END) AS converted_at,
 d.fields AS manual_fields,st.collected_details AS saved_fields,
 (SELECT jsonb_object_agg(f->>'field',f->>'value') FROM veo_contact_demographics ai CROSS JOIN LATERAL jsonb_array_elements(ai.fields) f WHERE ai.contact_id=c.id) AS ai_demographics,
 snap.payload->'extracted_answers' AS extracted_answers
 FROM ad_contact_sources s JOIN contacts c ON c.id=s.contact_id AND c.page_id=s.page_id LEFT JOIN veo_contact_details d ON d.contact_id=c.id
 LEFT JOIN chatbot_contact_states st ON st.contact_id=c.id AND st.page_id=p_page
 LEFT JOIN LATERAL(SELECT payload FROM contact_profile_snapshots WHERE contact_id=c.id AND page_id=p_page ORDER BY generation DESC LIMIT 1) snap ON true
 WHERE s.page_id=p_page AND s.attribution_status='verified_inline' AND s.origin_ad_id IS NOT NULL AND(p_ad IS NULL OR s.origin_ad_id=p_ad)
 AND s.first_inquiry_at>=(p_from::timestamp AT TIME ZONE 'Asia/Manila') AND s.first_inquiry_at<least(((p_to+1)::timestamp AT TIME ZONE 'Asia/Manila'),now())),
 orders AS MATERIALIZED(SELECT v.* FROM veo_calendar_order_values v JOIN cohort c ON c.id=v.contact_id WHERE v.page_id=p_page AND v.tenant_id=tenant AND(actor_role='owner' OR v.seller_id IN(SELECT veo_branch(p_actor))))
 SELECT jsonb_build_object('page_id',p_page,'from',p_from,'to',p_to,'as_of',statement_timestamp(),
 'clients',coalesce((SELECT jsonb_agg(to_jsonb(c)) FROM cohort c),'[]'),
 'orders',coalesce((SELECT jsonb_agg(to_jsonb(o)) FROM orders o),'[]'),
 'cash',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM(
 SELECT o.contact_id,o.currency,p.amount_minor*CASE WHEN p.kind='refund' THEN -1 ELSE 1 END AS amount_minor FROM veo_payments p JOIN veo_orders o ON o.id=p.order_id JOIN cohort c ON c.id=o.contact_id
 WHERE o.page_id=p_page AND o.seller_id IN(SELECT veo_branch(p_actor)) AND p.occurred_at<=now() AND c.stage='converted'
 UNION ALL SELECT p.contact_id,p.currency,p.amount_minor*CASE WHEN p.kind='refund' THEN -1 ELSE 1 END FROM contact_verified_payments p JOIN cohort c ON c.id=p.contact_id
 WHERE p.page_id=p_page AND p.voided_at IS NULL AND p.occurred_at<(SELECT launch_at FROM veo_tenants WHERE id=tenant) AND p.occurred_at<=now() AND(actor_role='owner' OR p.verified_by IN(SELECT veo_branch(p_actor)))) x),'[]'),
 'ads',coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM ad_source_catalog a WHERE a.page_id=p_page AND(p_ad IS NULL OR a.ad_id=p_ad)),'[]'),
 'spend',coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM ad_daily_spend s WHERE s.page_id=p_page AND s.spend_date BETWEEN p_from AND p_to AND(p_ad IS NULL OR s.ad_id=p_ad)),'[]'),
 'delivery_history',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM(SELECT ad_id,min(spend_date) FILTER(WHERE impressions>0 OR amount>0) AS first_delivery_date,
 max(spend_date) FILTER(WHERE impressions>0 OR amount>0) AS latest_delivery_date,count(DISTINCT spend_date) FILTER(WHERE impressions>0 OR amount>0) AS delivery_days
 FROM ad_daily_spend WHERE page_id=p_page AND(p_ad IS NULL OR ad_id=p_ad) GROUP BY ad_id) x),'[]'),
 'coverage',coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM veo_ad_spend_coverage s WHERE s.page_id=p_page AND s.spend_date BETWEEN p_from AND p_to),'[]'),
 'ad_planning',coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM veo_ad_planning_state s WHERE s.page_id=p_page),'[]')) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION veo_creative_inputs(uuid,uuid,date,date,text) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION veo_creative_inputs(uuid,uuid,date,date,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
