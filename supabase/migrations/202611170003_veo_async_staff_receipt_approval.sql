BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Save staff evidence independently of ledger calculations. A timeout during
-- automatic approval must not roll back an otherwise valid member receipt.
CREATE OR REPLACE FUNCTION veo_submit_deal_review(p_actor uuid,p_data jsonb,p_photos uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;BEGIN
 result:=veo_submit_deal_review_before_team_auto(p_actor,p_data,p_photos);
 IF result->>'status'='pending' AND NOT coalesce((result->>'duplicate')::boolean,false)
 AND veo_team_auto_approver((result->>'id')::uuid) IS NOT NULL THEN
  UPDATE veo_deal_reviews SET auto_approval_retry_at=now(),auto_approval_error=NULL
  WHERE id=(result->>'id')::uuid;
  result:=veo_deal_review_access(p_actor,(result->>'id')::uuid)||jsonb_build_object('duplicate',false);
 END IF;
 RETURN result;
END $$;
ALTER FUNCTION veo_deal_review_facts(uuid) RENAME TO veo_deal_review_facts_before_async_approval;
CREATE FUNCTION veo_deal_review_facts(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT veo_deal_review_facts_before_async_approval(p_id)||jsonb_build_object('auto_approval_pending',
  EXISTS(SELECT 1 FROM veo_deal_reviews r WHERE r.id=p_id AND r.status='pending' AND r.deleted_at IS NULL
   AND r.auto_approval_error IS NULL AND veo_team_auto_approver(r.id) IS NOT NULL))
$$;
REVOKE ALL ON FUNCTION veo_submit_deal_review(uuid,jsonb,uuid[]),veo_deal_review_facts(uuid),veo_deal_review_facts_before_async_approval(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_submit_deal_review(uuid,jsonb,uuid[]),veo_deal_review_facts(uuid),veo_deal_review_facts_before_async_approval(uuid) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611170003','Commit member evidence before the existing scheduled automatic approval worker')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
