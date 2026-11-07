BEGIN;
ALTER TABLE veo_contact_demographics ADD COLUMN requested_fields jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(requested_fields)='array');
ALTER TABLE veo_contact_demographics ADD COLUMN manual_version integer NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION veo_demographic_enqueue(p_contact uuid,p_manual boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pg uuid;
BEGIN
 SELECT c.page_id INTO pg FROM contacts c JOIN pages p ON p.id=c.page_id AND p.veo_enabled JOIN veo_tenants t ON t.id=p.veo_tenant_id
 WHERE c.id=p_contact AND t.launch_at IS NOT NULL AND veo_can_page(t.owner_id,p.id);
 IF pg IS NULL THEN RETURN false;END IF;
 INSERT INTO veo_contact_demographics(contact_id,page_id,next_attempt_at,manual_version) VALUES(p_contact,pg,now()+CASE WHEN p_manual THEN interval '-1 hour' ELSE interval '45 seconds' END,CASE WHEN p_manual THEN 1 ELSE 0 END)
 ON CONFLICT(contact_id) DO UPDATE SET requested_version=veo_contact_demographics.requested_version+1,
 manual_version=CASE WHEN p_manual THEN veo_contact_demographics.requested_version+1 ELSE veo_contact_demographics.manual_version END,
 status=CASE WHEN veo_contact_demographics.status='processing' AND veo_contact_demographics.lease_until>now() THEN 'processing' ELSE 'queued' END,
 next_attempt_at=CASE WHEN p_manual THEN now()-interval '1 hour' WHEN veo_contact_demographics.manual_version>veo_contact_demographics.analyzed_version THEN least(veo_contact_demographics.next_attempt_at,now())
 ELSE greatest(now()+interval '45 seconds',coalesce(veo_contact_demographics.analyzed_at,'-infinity')+interval '15 minutes') END;
 RETURN true;
END $$;
DO $migration$ DECLARE definition text;old_part text;BEGIN
 definition:=pg_get_functiondef('veo_demographic_finish(uuid,uuid,jsonb,text,text)'::regprocedure);
 old_part:=$old$ELSE greatest(next_attempt_at,now()+interval '15 minutes') END$old$;
 IF strpos(definition,old_part)=0 THEN RAISE EXCEPTION 'Expected auto-fill cooldown is missing';END IF;
 EXECUTE replace(definition,old_part,$new$WHEN requested_version>working_version AND manual_version>working_version THEN now()-interval '1 hour' ELSE greatest(next_attempt_at,now()+interval '15 minutes') END$new$);
END $migration$;
CREATE FUNCTION veo_profile_detail_access(p_actor uuid,p_contact uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT veo_demographic_access(p_actor,p_contact)||jsonb_build_object(
 'requested_fields',coalesce((SELECT requested_fields FROM veo_contact_demographics WHERE contact_id=p_contact),'[]'),
 'chatbot_fields',coalesce((SELECT to_jsonb(cfg.details_to_collect) FROM chatbot_configs cfg JOIN contacts c ON c.page_id=cfg.page_id WHERE c.id=p_contact),'[]'),
 'branch_worker_ids',coalesce((SELECT jsonb_agg(id) FROM veo_branch(p_actor) id),'[]'),
 'profile_facts',coalesce((SELECT payload->'facts' FROM contact_profile_snapshots WHERE contact_id=p_contact ORDER BY generation DESC LIMIT 1),'[]'))
$$;
CREATE FUNCTION veo_profile_detail_request(p_actor uuid,p_contact uuid,p_fields jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE before_fields jsonb;after_fields jsonb;tenant uuid;
BEGIN
 PERFORM veo_demographic_access(p_actor,p_contact);
 IF jsonb_typeof(p_fields)<>'array' OR jsonb_array_length(p_fields)>20 OR length(p_fields::text)>8000
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_fields) f WHERE jsonb_typeof(f)<>'object' OR coalesce(f->>'key','')!~'^[a-z][a-z0-9_]{1,63}$'
 OR jsonb_typeof(f->'label') IS DISTINCT FROM 'string' OR coalesce(length(btrim(f->>'label')),0) NOT BETWEEN 2 AND 80 OR f->>'key'~'payment|paid|refund|salary|commission|gross|profit|lifetime|ltv|stage|verified|amount|order_total|average_order|revenue|aov|password|token|secret')
 THEN RAISE EXCEPTION 'Choose customer detail labels, not financial or account-control fields';END IF;
 PERFORM veo_demographic_enqueue(p_contact,true);
 SELECT requested_fields INTO before_fields FROM veo_contact_demographics WHERE contact_id=p_contact FOR UPDATE;
 SELECT coalesce(jsonb_agg(value ORDER BY value->>'key'),'[]') INTO after_fields FROM(SELECT DISTINCT ON(value->>'key') value FROM(
 SELECT value,0 AS priority FROM jsonb_array_elements(before_fields) UNION ALL SELECT value,1 FROM jsonb_array_elements(p_fields)) f ORDER BY value->>'key',priority) unique_fields;
 IF jsonb_array_length(after_fields)>20 THEN RAISE EXCEPTION 'Use at most 20 additional customer details';END IF;
 UPDATE veo_contact_demographics SET requested_fields=after_fields,source_hash=NULL WHERE contact_id=p_contact;
 SELECT p.veo_tenant_id INTO tenant FROM contacts c JOIN pages p ON p.id=c.page_id WHERE c.id=p_contact;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value) VALUES(tenant,p_actor,'profile_fields_requested',p_contact,before_fields,after_fields);
 RETURN veo_profile_detail_access(p_actor,p_contact);
END $$;
ALTER FUNCTION veo_demographic_sources(uuid,uuid) RENAME TO veo_demographic_sources_base;
CREATE FUNCTION veo_demographic_sources(p_contact uuid,p_claim uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT veo_demographic_sources_base(p_contact,p_claim)||jsonb_build_object(
 'requested_fields',coalesce((SELECT requested_fields FROM veo_contact_demographics WHERE contact_id=p_contact),'[]'),
 'chatbot_fields',coalesce((SELECT to_jsonb(cfg.details_to_collect) FROM chatbot_configs cfg JOIN contacts c ON c.page_id=cfg.page_id WHERE c.id=p_contact),'[]'))
$$;
REVOKE ALL ON FUNCTION veo_profile_detail_access(uuid,uuid),veo_profile_detail_request(uuid,uuid,jsonb),veo_demographic_sources(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_profile_detail_access(uuid,uuid),veo_profile_detail_request(uuid,uuid,jsonb),veo_demographic_sources(uuid,uuid) TO service_role;
-- Upgrade contacts already enrolled by new-period events or explicit analysis.
-- Contacts without a profile job are not added by this upgrade.
UPDATE veo_contact_demographics d SET requested_version=requested_version+1,status=CASE WHEN status='processing' AND lease_until>now() THEN status ELSE 'queued' END,next_attempt_at=now()
 FROM pages p,veo_tenants t WHERE p.id=d.page_id AND p.veo_enabled AND t.id=p.veo_tenant_id AND t.launch_at IS NOT NULL AND veo_can_page(t.owner_id,p.id);
NOTIFY pgrst,'reload schema';
COMMIT;
