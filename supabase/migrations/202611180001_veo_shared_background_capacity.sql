BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Separate HTTP workers used to compete for the same small database. Admit
-- one heavy background SQL transaction at a time, without making others wait
-- or taking this lock on interactive authorization and receipt intake.
CREATE FUNCTION veo_require_background_capacity() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('veo-heavy-background-capacity',0)) THEN
  RAISE EXCEPTION 'Background database capacity is in use; retry on the next scheduled run' USING ERRCODE='55P03';
 END IF;
END $$;
REVOKE ALL ON FUNCTION veo_require_background_capacity() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_require_background_capacity() TO service_role;

-- Preserve each function's owner, privileges, parameters, defaults, timeout
-- settings and accounting logic. The gate runs before its original work.
DO $migration$
DECLARE signature text;definition text;source text;patched text;at integer;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'veo_maintenance()', 'veo_operations_maintenance()',
  'veo_automatic_intake_tick(uuid,timestamp with time zone)',
  'veo_refresh_worker_quota(uuid,uuid)',
  'veo_auto_approve_pending_team_reviews(integer,uuid)',
  'veo_refresh_all_discipline()'
 ] LOOP
  SELECT prosrc INTO source FROM pg_proc WHERE oid=signature::regprocedure;
  at:=strpos(source,'BEGIN');
  IF at=0 OR strpos(source,'veo_require_background_capacity')>0 THEN RAISE EXCEPTION 'Background capacity integration point changed: %',signature;END IF;
  definition:=pg_get_functiondef(signature::regprocedure);
  patched:=overlay(source placing E'BEGIN\n PERFORM public.veo_require_background_capacity();' from at for 5);
  EXECUTE replace(definition,source,patched);
 END LOOP;
END $migration$;
INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611180001','Nonblocking shared admission for heavy background SQL; preserve interactive access and receipt intake') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
