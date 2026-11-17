BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Evidence intake and automatic approval are separate operations. An invalid
-- approval must leave staff evidence available for independent review, just as
-- the scheduled pending-review worker already does. Keep intake authorization,
-- evidence validation and idempotency outside the approval savepoint.
CREATE OR REPLACE FUNCTION veo_submit_deal_review(p_actor uuid,p_data jsonb,p_photos uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;approved jsonb;BEGIN
 result:=veo_submit_deal_review_before_team_auto(p_actor,p_data,p_photos);
 IF result->>'status'='pending' AND coalesce((result->>'duplicate')::boolean,false)=false THEN
  BEGIN
   approved:=veo_auto_approve_team_review((result->>'id')::uuid);
   IF approved IS NOT NULL THEN result:=approved||jsonb_build_object('duplicate',false);END IF;
  EXCEPTION WHEN OTHERS THEN
   UPDATE veo_deal_reviews SET
    auto_approval_error='Automatic approval could not pass the current evidence, order or payment checks. Review this submission.',
    auto_approval_retry_at=clock_timestamp()+interval '5 minutes'
   WHERE id=(result->>'id')::uuid;
   result:=veo_deal_review_access(p_actor,(result->>'id')::uuid)||jsonb_build_object('duplicate',false);
  END;
 END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION veo_submit_deal_review(uuid,jsonb,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_submit_deal_review(uuid,jsonb,uuid[]) TO service_role;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611170002','Preserve staff receipt evidence when team automatic approval needs review')
ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
