BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE veo_deal_review_settings ADD COLUMN supervisor_submissions_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE veo_deal_reviews ADD COLUMN approval_mode text NOT NULL DEFAULT 'supervisor_review' CHECK(approval_mode IN('supervisor_review','supervisor_submission'));
ALTER TABLE veo_deal_reviews ADD COLUMN submitted_by_role text CHECK(submitted_by_role IN('owner','team_leader','manager','member'));

CREATE FUNCTION veo_supervisor_submissions_enabled(p_tenant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT enabled AND supervisor_submissions_enabled FROM veo_deal_review_settings WHERE tenant_id=p_tenant),false)
$$;
CREATE OR REPLACE FUNCTION veo_scope(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN result:=veo_scope_before_deal_review(p_actor);IF result IS NULL THEN RETURN NULL;END IF;
 RETURN result||jsonb_build_object('reviewed_deals_enabled',veo_reviewed_deals_enabled((result->>'tenant_id')::uuid),'supervisor_submissions_enabled',veo_supervisor_submissions_enabled((result->>'tenant_id')::uuid));END $$;

-- The ledger still uses the existing atomic approval implementation. Only a
-- submission made by an authorized supervisor can use its own submitter as
-- the verifier; staff evidence continues to require a different supervisor.
DO $$ DECLARE definition text;needle text:=$old$IF a.role NOT IN('owner','team_leader','manager') OR p_actor IN(r.seller_id,r.submitted_by) THEN$old$;BEGIN
 definition:=pg_get_functiondef('veo_review_deal(uuid,uuid,text,boolean,boolean,boolean,text)'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Receipt review authorization implementation changed';END IF;
 EXECUTE replace(definition,needle,$new$IF a.role NOT IN('owner','team_leader','manager') OR (p_actor IN(r.seller_id,r.submitted_by) AND NOT(r.approval_mode='supervisor_submission' AND p_actor=r.submitted_by AND r.submitted_by_role=a.role AND veo_supervisor_submissions_enabled(r.tenant_id))) THEN$new$);
END $$;
ALTER FUNCTION veo_submit_deal_review(uuid,jsonb,uuid[]) RENAME TO veo_submit_deal_review_before_supervisor;
CREATE FUNCTION veo_submit_deal_review(p_actor uuid,p_data jsonb,p_photos uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;a veo_accounts;rid uuid;duplicate boolean;BEGIN
 result:=veo_submit_deal_review_before_supervisor(p_actor,p_data,p_photos);rid:=(result->>'id')::uuid;duplicate:=coalesce((result->>'duplicate')::boolean,false);
 IF result->>'status'='pending' THEN
  SELECT x.* INTO a FROM veo_accounts x JOIN users u ON u.id=x.user_id AND u.is_active WHERE x.user_id=p_actor AND x.active;
  UPDATE veo_deal_reviews SET submitted_by_role=a.role WHERE id=rid AND submitted_by=p_actor AND status='pending';
  IF a.role IN('owner','team_leader','manager') AND veo_supervisor_submissions_enabled(a.tenant_id) THEN
   UPDATE veo_deal_reviews SET approval_mode='supervisor_submission' WHERE id=rid AND submitted_by=p_actor AND status='pending';
   result:=veo_review_deal(p_actor,rid,'approve',true,true,true,'Submitted by '||replace(a.role,'_',' ')||'; separate review not required');
   INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(a.tenant_id,p_actor,'deal_evidence_supervisor_submission',rid,jsonb_build_object('submitted_by_role',a.role,'receipt_kind',p_data->>'receipt_kind'),'Supervisor submission recorded and queued without a separate review');
  ELSE result:=veo_deal_review_access(p_actor,rid);END IF;
 END IF;
 RETURN result||jsonb_build_object('duplicate',duplicate);
END $$;

-- Attest how the submission was authorized for Jaucian. Client-supplied role
-- fields are never used to decide whether an independent review is needed.
ALTER FUNCTION veo_reviewed_deal_handoff(uuid) RENAME TO veo_reviewed_deal_handoff_before_supervisor;
CREATE FUNCTION veo_reviewed_deal_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;r veo_deal_reviews;direct boolean;BEGIN
 result:=veo_reviewed_deal_handoff_before_supervisor(p_submission);IF result IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO r FROM veo_deal_reviews WHERE id=(result->>'deal_review_id')::uuid;
 direct:=r.approval_mode='supervisor_submission' AND r.submitted_by_role IN('owner','team_leader','manager') AND r.reviewed_by=r.submitted_by;
 IF (r.approval_mode='supervisor_submission' AND direct IS NOT TRUE) OR (r.approval_mode='supervisor_review' AND r.reviewed_by IN(r.submitted_by,r.seller_id)) THEN RETURN NULL;END IF;
 RETURN result||jsonb_build_object('approval_mode',r.approval_mode,'submitted_by',r.submitted_by,'submitted_by_role',r.submitted_by_role,'direct_submission_authorized',direct);
END $$;
DO $$ DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_supervisor_submissions_enabled','veo_submit_deal_review','veo_submit_deal_review_before_supervisor','veo_reviewed_deal_handoff','veo_reviewed_deal_handoff_before_supervisor','veo_review_deal','veo_scope') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
