BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE veo_deal_reviews ADD COLUMN deleted_at timestamptz,ADD COLUMN deleted_by uuid REFERENCES users(id),ADD COLUMN delete_reason text;
CREATE TABLE veo_receipt_deletion_outbox(submission_id uuid PRIMARY KEY REFERENCES veo_submissions(id),created_at timestamptz NOT NULL DEFAULT now(),queued_at timestamptz,last_error text);
ALTER TABLE veo_receipt_deletion_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_receipt_deletion_outbox FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_receipt_deletion_outbox TO service_role;

CREATE FUNCTION veo_require_receipt_deleter(p_actor uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM veo_accounts a JOIN users u ON u.id=a.user_id AND u.is_active WHERE a.user_id=p_actor AND a.active AND a.role IN('manager','team_leader')) THEN
 RAISE EXCEPTION 'Only Managers and Team Leaders can delete receipts. Ask your Manager or Team Leader.' USING ERRCODE='42501';END IF;
END $$;

ALTER FUNCTION veo_receipt_delete(uuid,uuid,text,boolean) RENAME TO veo_receipt_delete_before_supervisor_only;
CREATE FUNCTION veo_receipt_delete(p_actor uuid,p_id uuid,p_reason text,p_cancel_closed boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 PERFORM veo_require_receipt_deleter(p_actor);
 result:=veo_receipt_delete_before_supervisor_only(p_actor,p_id,p_reason,p_cancel_closed);
 INSERT INTO veo_receipt_deletion_outbox(submission_id) SELECT delivery_submission FROM veo_receipts WHERE id=p_id AND delivery_submission IS NOT NULL ON CONFLICT DO NOTHING;
 RETURN result;
END $$;

CREATE FUNCTION veo_deal_review_delete(p_actor uuid,p_id uuid,p_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_deal_reviews;BEGIN
 PERFORM veo_require_receipt_deleter(p_actor);PERFORM veo_deal_review_access(p_actor,p_id);
 SELECT * INTO r FROM veo_deal_reviews WHERE id=p_id FOR UPDATE;
 IF r.deleted_at IS NOT NULL THEN RETURN veo_deal_review_access(p_actor,p_id);END IF;
 IF length(btrim(coalesce(p_reason,'')))<3 OR length(p_reason)>500 THEN RAISE EXCEPTION 'Enter a deletion reason of 3 to 500 characters';END IF;
 UPDATE veo_deal_reviews SET deleted_at=clock_timestamp(),deleted_by=p_actor,delete_reason=btrim(p_reason) WHERE id=p_id;
 UPDATE veo_submissions SET status='blocked',last_error='Receipt deleted before delivery',claim_token=NULL,lease_until=NULL WHERE id=r.delivery_submission AND status IN('queued','processing');
 INSERT INTO veo_receipt_deletion_outbox(submission_id) SELECT r.delivery_submission WHERE r.delivery_submission IS NOT NULL ON CONFLICT DO NOTHING;
 UPDATE veo_photo_objects SET expires_at=least(expires_at,clock_timestamp()) WHERE object_path IN(SELECT object_path FROM veo_deal_review_photos WHERE review_id=p_id);
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(r.tenant_id,p_actor,'deal_receipt_deleted',p_id,to_jsonb(r)-'payload',jsonb_build_object('deleted',true,'financial_records_retained',true),btrim(p_reason));
 RETURN veo_deal_review_access(p_actor,p_id);
END $$;

-- Guard approval, enqueue and handoff even for direct service calls.
DO $$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_review_deal(uuid,uuid,text,boolean,boolean,boolean,text)'::regprocedure);
 definition:=replace(definition,'IF a.role NOT IN', 'IF r.deleted_at IS NOT NULL THEN RAISE EXCEPTION ''Deleted receipts cannot be reviewed'';END IF;IF a.role NOT IN');EXECUTE definition;
 definition:=pg_get_functiondef('veo_queue_reviewed_deal(uuid)'::regprocedure);
 definition:=replace(definition,'id=p_review AND status=''approved''','id=p_review AND deleted_at IS NULL AND status=''approved''');EXECUTE definition;
 definition:=pg_get_functiondef('veo_enqueue_approved_deal_reviews(integer)'::regprocedure);
 definition:=replace(definition,'WHERE status=''approved''','WHERE deleted_at IS NULL AND status=''approved''');EXECUTE definition;
 definition:=pg_get_functiondef('veo_deal_review_access(uuid,uuid)'::regprocedure);
 definition:=replace(definition,'''can_review'',a.role', '''can_delete'',a.role IN(''manager'',''team_leader'') AND r.deleted_at IS NULL,''can_review'',r.deleted_at IS NULL AND a.role');EXECUTE definition;
END $$;

ALTER FUNCTION veo_submission_receipt_deleted(uuid) RENAME TO veo_submission_receipt_deleted_before_reviews;
CREATE FUNCTION veo_submission_receipt_deleted(p_submission uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT veo_submission_receipt_deleted_before_reviews(p_submission) OR EXISTS(SELECT 1 FROM veo_deal_reviews WHERE delivery_submission=p_submission AND deleted_at IS NOT NULL)
$$;
ALTER FUNCTION veo_handoff(uuid) RENAME TO veo_handoff_before_review_deletion;
CREATE FUNCTION veo_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN IF veo_submission_receipt_deleted(p_submission) THEN RETURN NULL;END IF;RETURN veo_handoff_before_review_deletion(p_submission);END $$;

DO $$ DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_require_receipt_deleter','veo_receipt_delete','veo_receipt_delete_before_supervisor_only','veo_deal_review_delete','veo_submission_receipt_deleted','veo_submission_receipt_deleted_before_reviews','veo_handoff','veo_handoff_before_review_deletion') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
