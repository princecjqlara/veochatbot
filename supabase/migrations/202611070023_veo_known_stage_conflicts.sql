BEGIN;
CREATE INDEX veo_business_order_contact_message ON veo_business_orders(contact_id,page_id,message_id);
-- A fresh Graph read may omit a newer notice already retained from a signed
-- webhook. It cannot revive an older, conflicting stage. Invoice notices do
-- not constitute lead-stage changes and are excluded only by exact message ID.
CREATE FUNCTION veo_facebook_stage_conflicts(p_contact uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' AS $$
 WITH check_state AS MATERIALIZED(SELECT * FROM veo_facebook_checks WHERE contact_id=p_contact),
 known AS MATERIALIZED(
  SELECT e.stage,e.occurred_at FROM messenger_lead_stage_events e JOIN check_state f ON f.contact_id=e.contact_id AND f.page_id=e.page_id
  WHERE e.occurred_at>=f.stage_occurred_at AND NOT(e.stage='order_created' AND EXISTS(
   SELECT 1 FROM veo_business_orders b WHERE b.contact_id=e.contact_id AND b.page_id=e.page_id AND b.message_id=e.message_id))
 )
 SELECT EXISTS(SELECT 1 FROM known k CROSS JOIN check_state f WHERE k.occurred_at=(SELECT max(occurred_at) FROM known) AND k.stage IS DISTINCT FROM f.stage)
$$;

ALTER FUNCTION veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean) RENAME TO veo_receipt_requirements_before_stage_conflicts;
CREATE FUNCTION veo_receipt_requirements(p_actor uuid,p_contact uuid,p_seller uuid,p_kind text,p_order uuid DEFAULT NULL,p_fresh boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE result jsonb;BEGIN
 result:=veo_receipt_requirements_before_stage_conflicts(p_actor,p_contact,p_seller,p_kind,p_order,p_fresh);
 IF veo_facebook_stage_conflicts(p_contact) THEN RETURN result||jsonb_build_object('allowed',false,'blockers',(result->'blockers')||'"facebook_stage_conflict"'::jsonb);END IF;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION veo_record_facebook_check(p_actor uuid,p_contact uuid,p_started_at timestamptz,p_scan jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;f veo_facebook_checks;c contacts;BEGIN
 result:=veo_record_facebook_check_before_explicit_stage(p_actor,p_contact,p_started_at,p_scan);
 SELECT * INTO f FROM veo_facebook_checks WHERE contact_id=p_contact AND started_at=p_started_at;
 SELECT * INTO c FROM contacts WHERE id=p_contact FOR UPDATE;
 IF f.complete AND f.error IS NULL AND f.stage IN('qualified','converted','not_qualified','new','engaged','collecting_details','order_created','opted_out')
 AND NOT veo_facebook_stage_conflicts(p_contact) AND c.pipeline_stage='order_created' AND c.pipeline_stage_source='messenger'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_scan->'orders','[]')) n WHERE n->>'message_id'=c.messenger_stage_message_id) THEN
  UPDATE contacts SET pipeline_stage=f.stage,pipeline_stage_source='messenger',pipeline_stage_updated_at=clock_timestamp(),messenger_stage_label=initcap(replace(f.stage,'_',' ')),
   messenger_stage_event_at=f.stage_occurred_at,messenger_stage_message_id=f.stage_message_id WHERE id=c.id;
  UPDATE messenger_lead_stage_events SET applied=true WHERE page_id=c.page_id AND contact_id=c.id AND message_id=f.stage_message_id;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason)
  VALUES(f.tenant_id,p_actor,'facebook_explicit_stage_restored',c.id,jsonb_build_object('stage',c.pipeline_stage,'source',c.pipeline_stage_source),jsonb_build_object('stage',f.stage,'source','messenger','occurred_at',f.stage_occurred_at),
   'Fresh Facebook read confirms an explicit lead stage; the invoice notice is order evidence only');
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION veo_facebook_stage_conflicts(uuid),veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean),veo_record_facebook_check(uuid,uuid,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_facebook_stage_conflicts(uuid),veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean),veo_record_facebook_check(uuid,uuid,timestamptz,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
