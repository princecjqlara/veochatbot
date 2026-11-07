BEGIN;
ALTER TABLE veo_receipts ADD COLUMN deleted_at timestamptz,ADD COLUMN deleted_by uuid REFERENCES users(id),ADD COLUMN delete_reason text;
ALTER TABLE veo_closed_deals ADD COLUMN voided_at timestamptz,ADD COLUMN voided_by uuid REFERENCES users(id),ADD COLUMN void_reason text;
CREATE INDEX veo_receipts_active_scope ON veo_receipts(tenant_id,seller_id,created_at DESC) WHERE deleted_at IS NULL;
DO $migration$ DECLARE definition text;fn record;BEGIN
 definition:=rtrim(pg_get_viewdef('veo_sales_facts'::regclass,true),E';\n ');
 EXECUTE 'CREATE OR REPLACE VIEW veo_sales_facts AS '||definition||' AND d.voided_at IS NULL';
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'veo_%' LOOP
  definition:=pg_get_functiondef(fn.signature);
  definition:=replace(definition,'FROM veo_closed_deals WHERE','FROM veo_closed_deals WHERE voided_at IS NULL AND');
  definition:=replace(definition,'WHERE x.tenant_id=a.tenant_id AND x.contact_id=c.id','WHERE x.voided_at IS NULL AND x.tenant_id=a.tenant_id AND x.contact_id=c.id');
  EXECUTE definition;
 END LOOP;
 definition:=pg_get_functiondef('veo_link_closed_deal(uuid,uuid,uuid)'::regprocedure);
 definition:=replace(definition,'IF d.id IS NULL OR o.id IS NULL','IF d.id IS NULL OR d.voided_at IS NOT NULL OR o.id IS NULL');EXECUTE definition;
 definition:=pg_get_functiondef('veo_receipts_page(uuid,date,date,uuid,uuid,integer)'::regprocedure);
 definition:=replace(definition,'WHERE r.tenant_id=tenant','WHERE r.deleted_at IS NULL AND r.tenant_id=tenant');EXECUTE definition;
 definition:=pg_get_functiondef('veo_receipt_save(uuid,jsonb)'::regprocedure);
 definition:=replace(definition,'OR(r.photo_sha256=', 'OR(r.deleted_at IS NULL AND r.photo_sha256=');EXECUTE definition;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_workflow_warnings','veo_operations_report') LOOP
  definition:=replace(pg_get_functiondef(fn.signature),'WHERE r.tenant_id=','WHERE r.deleted_at IS NULL AND r.tenant_id=');EXECUTE definition;
 END LOOP;
END $migration$;

ALTER FUNCTION veo_receipt_facts(uuid) RENAME TO veo_receipt_facts_before_delete;
CREATE FUNCTION veo_receipt_facts(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 result:=veo_receipt_facts_before_delete(p_id);
 IF result->>'deleted_at' IS NOT NULL THEN RETURN result||jsonb_build_object('holds',jsonb_build_array('receipt_deleted'),'salary_holds','[]'::jsonb,'salary_status','deleted','delivery_status','deleted','photo_available',false);END IF;
 RETURN result;
END $$;
ALTER FUNCTION veo_receipt_recheck(uuid,uuid,uuid) RENAME TO veo_receipt_recheck_before_delete;
CREATE FUNCTION veo_receipt_recheck(p_actor uuid,p_id uuid,p_order uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_receipts;BEGIN
 PERFORM veo_receipt_access(p_actor,p_id);SELECT * INTO r FROM veo_receipts WHERE id=p_id FOR UPDATE;
 IF r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Deleted receipts cannot be rechecked';END IF;
 -- Only a never-sent queue blocked by deletion can safely switch to alternative
 -- evidence. An uncertain in-flight acknowledgment still requires review.
 UPDATE veo_submissions SET object_path=r.object_path,expires_at=p.expires_at,deleted_at=NULL FROM veo_photo_objects p
 WHERE veo_submissions.id=r.delivery_submission AND p.object_path=r.object_path AND p.deleted_at IS NULL AND p.expires_at>now()
 AND status='blocked' AND last_error='Receipt deleted before delivery' AND veo_submissions.object_path<>r.object_path;
 RETURN veo_receipt_recheck_before_delete(p_actor,p_id,p_order);
END $$;
ALTER FUNCTION veo_receipt_note(uuid,uuid,text) RENAME TO veo_receipt_note_before_delete;
CREATE FUNCTION veo_receipt_note(p_actor uuid,p_id uuid,p_notes text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM veo_receipt_access(p_actor,p_id);PERFORM 1 FROM veo_receipts WHERE id=p_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM veo_receipts WHERE id=p_id AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'Deleted receipt notes are read-only';END IF;
 RETURN veo_receipt_note_before_delete(p_actor,p_id,p_notes);
END $$;
ALTER FUNCTION veo_handoff(uuid) RENAME TO veo_handoff_before_receipt_delete;
CREATE FUNCTION veo_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM veo_submissions s JOIN veo_receipts r ON r.object_path=s.object_path WHERE s.id=p_submission AND r.deleted_at IS NOT NULL) THEN RETURN NULL;END IF;
 RETURN veo_handoff_before_receipt_delete(p_submission);
END $$;
CREATE FUNCTION veo_submission_receipt_deleted(p_submission uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM veo_submissions s JOIN veo_receipts r ON r.object_path=s.object_path WHERE s.id=p_submission AND r.deleted_at IS NOT NULL)
$$;

CREATE FUNCTION veo_receipt_delete(p_actor uuid,p_id uuid,p_reason text,p_cancel_closed boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_receipts;d veo_closed_deals;BEGIN
 -- Receipt access restricts members to their own seller identity and managers,
 -- leaders and Owner to their active tenant, seller branch and current Pages.
 PERFORM veo_receipt_access(p_actor,p_id);SELECT * INTO r FROM veo_receipts WHERE id=p_id FOR UPDATE;
 IF r.deleted_at IS NOT NULL THEN RETURN veo_receipt_facts(r.id);END IF;
 IF length(btrim(coalesce(p_reason,'')))<3 OR length(p_reason)>500 THEN RAISE EXCEPTION 'Enter a deletion reason of 3 to 500 characters';END IF;
 IF p_cancel_closed THEN
  SELECT * INTO d FROM veo_closed_deals WHERE id=r.closed_deal_id FOR UPDATE;
  IF r.receipt_kind<>'closed' OR d.id IS NULL OR d.order_id IS NOT NULL OR d.verified_payment_id IS NOT NULL THEN RAISE EXCEPTION 'Only an unlinked Closed Deal without verified payments can be cancelled here';END IF;
  IF EXISTS(SELECT 1 FROM veo_receipts WHERE closed_deal_id=d.id AND id<>r.id AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Delete the other receipt copies for this Closed Deal first';END IF;
  UPDATE veo_closed_deals SET voided_at=clock_timestamp(),voided_by=p_actor,void_reason=btrim(p_reason) WHERE id=d.id;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(r.tenant_id,p_actor,'closed_deal_cancelled',d.id,to_jsonb(d),jsonb_build_object('voided',true),btrim(p_reason));
 END IF;
 UPDATE veo_receipts SET deleted_at=clock_timestamp(),deleted_by=p_actor,delete_reason=btrim(p_reason) WHERE id=r.id;
 UPDATE veo_submissions SET status='blocked',last_error=CASE WHEN status='processing' THEN 'Receipt deleted during processing; acknowledgment review required' ELSE 'Receipt deleted before delivery' END,claim_token=NULL,lease_until=NULL
 WHERE object_path=r.object_path AND status IN('queued','processing');
 UPDATE veo_photo_objects SET expires_at=least(expires_at,clock_timestamp()) WHERE object_path=r.object_path;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(r.tenant_id,p_actor,'receipt_deleted',r.id,to_jsonb(r)-'object_path'-'photo_sha256',jsonb_build_object('deleted',true,'closed_deal_cancelled',p_cancel_closed),btrim(p_reason));
 RETURN veo_receipt_facts(r.id);
END $$;
REVOKE ALL ON FUNCTION veo_receipt_facts(uuid),veo_receipt_recheck(uuid,uuid,uuid),veo_receipt_note(uuid,uuid,text),veo_handoff(uuid),veo_submission_receipt_deleted(uuid),veo_receipt_delete(uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_receipt_facts(uuid),veo_receipt_recheck(uuid,uuid,uuid),veo_receipt_note(uuid,uuid,text),veo_handoff(uuid),veo_submission_receipt_deleted(uuid),veo_receipt_delete(uuid,uuid,text,boolean) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
