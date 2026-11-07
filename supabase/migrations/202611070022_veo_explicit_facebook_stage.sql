BEGIN;
-- An invoice notice proves order creation, not a change to the lead stage.
-- Correct an earlier inferred Order Created stage only when the fresh bounded
-- read contains that exact invoice notice and an explicit lead-stage notice.
-- Explicit Order Created notices and manual corrections remain untouched.
ALTER FUNCTION veo_record_facebook_check(uuid,uuid,timestamptz,jsonb) RENAME TO veo_record_facebook_check_before_explicit_stage;
CREATE FUNCTION veo_record_facebook_check(p_actor uuid,p_contact uuid,p_started_at timestamptz,p_scan jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;f veo_facebook_checks;c contacts;BEGIN
 result:=veo_record_facebook_check_before_explicit_stage(p_actor,p_contact,p_started_at,p_scan);
 SELECT * INTO f FROM veo_facebook_checks WHERE contact_id=p_contact AND started_at=p_started_at;
 SELECT * INTO c FROM contacts WHERE id=p_contact FOR UPDATE;
 IF f.complete AND f.error IS NULL AND f.stage IN('qualified','converted','not_qualified','new','engaged','collecting_details','order_created','opted_out')
 AND c.pipeline_stage='order_created' AND c.pipeline_stage_source='messenger'
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
REVOKE ALL ON FUNCTION veo_record_facebook_check(uuid,uuid,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_record_facebook_check(uuid,uuid,timestamptz,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
