BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE veo_team_auto_approval(supervisor_id uuid PRIMARY KEY REFERENCES veo_accounts(user_id),enabled boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE veo_team_auto_approval ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_team_auto_approval FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_team_auto_approval TO service_role;
ALTER TABLE veo_deal_reviews ADD COLUMN auto_approved boolean NOT NULL DEFAULT false,ADD COLUMN auto_approval_error text,ADD COLUMN auto_approval_retry_at timestamptz;

CREATE FUNCTION veo_team_auto_approval_setting(p_actor uuid,p_enabled boolean DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;setting boolean;BEGIN
 SELECT x.* INTO a FROM veo_accounts x JOIN users u ON u.id=x.user_id AND u.is_active WHERE x.user_id=p_actor AND x.active;
 IF a.role NOT IN('manager','team_leader') OR a.user_id IS NULL THEN RAISE EXCEPTION 'Manager or Team Leader access required' USING ERRCODE='42501';END IF;
 IF p_enabled IS NOT NULL THEN
  INSERT INTO veo_team_auto_approval(supervisor_id,enabled) VALUES(p_actor,p_enabled) ON CONFLICT(supervisor_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=clock_timestamp();
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(a.tenant_id,p_actor,'team_receipt_auto_approval_setting',p_actor,jsonb_build_object('enabled',p_enabled),'Automatically approve valid pending and future team Close Deal and Done Deal submissions');
 END IF;
 SELECT enabled INTO setting FROM veo_team_auto_approval WHERE supervisor_id=p_actor;
 RETURN jsonb_build_object('enabled',coalesce(setting,false),'scope','your_team','covers',jsonb_build_array('closed','done'),'includes_pending',true);
END $$;

-- The closest enabled supervisor wins. An enabled Team Leader can cover a
-- Manager branch as well. Recheck active role, branch and Page on every save.
CREATE FUNCTION veo_team_auto_approver(p_review uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT a.user_id FROM veo_deal_reviews r JOIN veo_accounts seller ON seller.user_id=r.seller_id
 JOIN veo_accounts a ON a.tenant_id=r.tenant_id AND a.active AND a.role IN('manager','team_leader')
 JOIN users u ON u.id=a.user_id AND u.is_active
 JOIN veo_team_auto_approval policy ON policy.supervisor_id=a.user_id AND policy.enabled
 WHERE r.id=p_review AND r.status='pending' AND r.deleted_at IS NULL
 AND a.user_id NOT IN(r.seller_id,r.submitted_by) AND r.seller_id IN(SELECT veo_descendants(a.user_id))
 AND veo_can_page(a.user_id,r.page_id)
 ORDER BY (a.user_id=seller.parent_id) DESC,(a.role='manager') DESC,a.user_id LIMIT 1
$$;

CREATE FUNCTION veo_auto_approve_team_review(p_review uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE supervisor uuid;r veo_deal_reviews;result jsonb;BEGIN
 SELECT * INTO r FROM veo_deal_reviews WHERE id=p_review FOR UPDATE;
 supervisor:=veo_team_auto_approver(p_review);IF supervisor IS NULL THEN RETURN NULL;END IF;
 UPDATE veo_deal_reviews SET auto_approved=true,auto_approval_error=NULL,auto_approval_retry_at=NULL WHERE id=p_review;
 result:=veo_review_deal(supervisor,p_review,'approve',true,true,true,'Automatically approved under the supervisor''s team auto-approval setting');
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(r.tenant_id,supervisor,'team_deal_evidence_auto_approved',p_review,jsonb_build_object('receipt_kind',r.receipt_kind,'submitted_by',r.submitted_by),'Authorized team-wide automatic approval; original evidence and ledger validation retained');
 RETURN result;
END $$;

ALTER FUNCTION veo_submit_deal_review(uuid,jsonb,uuid[]) RENAME TO veo_submit_deal_review_before_team_auto;
CREATE FUNCTION veo_submit_deal_review(p_actor uuid,p_data jsonb,p_photos uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;approved jsonb;BEGIN
 result:=veo_submit_deal_review_before_team_auto(p_actor,p_data,p_photos);
 IF result->>'status'='pending' AND coalesce((result->>'duplicate')::boolean,false)=false THEN
  approved:=veo_auto_approve_team_review((result->>'id')::uuid);
  IF approved IS NOT NULL THEN result:=approved||jsonb_build_object('duplicate',false);END IF;
 END IF;
 RETURN result;
END $$;

CREATE FUNCTION veo_auto_approve_pending_team_reviews(p_limit integer DEFAULT 20,p_supervisor uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE r record;approved integer:=0;failed integer:=0;BEGIN
 FOR r IN SELECT id FROM veo_deal_reviews WHERE status='pending' AND deleted_at IS NULL AND (auto_approval_retry_at IS NULL OR auto_approval_retry_at<=now()) AND veo_team_auto_approver(id) IS NOT NULL AND(p_supervisor IS NULL OR veo_team_auto_approver(id)=p_supervisor) ORDER BY created_at LIMIT least(greatest(p_limit,1),50) FOR UPDATE SKIP LOCKED LOOP
  BEGIN
   IF veo_auto_approve_team_review(r.id) IS NOT NULL THEN approved:=approved+1;END IF;
  EXCEPTION WHEN OTHERS THEN
   UPDATE veo_deal_reviews SET auto_approval_error='Automatic approval could not pass the current evidence, order or payment checks. Review this submission.',auto_approval_retry_at=now()+interval '5 minutes' WHERE id=r.id;
   failed:=failed+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('approved',approved,'needs_review',failed);
END $$;

ALTER FUNCTION veo_reviewed_deal_handoff(uuid) RENAME TO veo_reviewed_deal_handoff_before_team_auto;
CREATE FUNCTION veo_reviewed_deal_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;automatic boolean;BEGIN
 result:=veo_reviewed_deal_handoff_before_team_auto(p_submission);IF result IS NULL THEN RETURN NULL;END IF;
 SELECT auto_approved INTO automatic FROM veo_deal_reviews WHERE id=(result->>'deal_review_id')::uuid;
 RETURN result||jsonb_build_object('auto_approved',coalesce(automatic,false));
END $$;

DO $$ DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_team_auto_approval_setting','veo_team_auto_approver','veo_auto_approve_team_review','veo_submit_deal_review','veo_submit_deal_review_before_team_auto','veo_auto_approve_pending_team_reviews','veo_reviewed_deal_handoff','veo_reviewed_deal_handoff_before_team_auto') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
