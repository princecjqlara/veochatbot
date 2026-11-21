BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';

-- Only scheduling metadata. Financial calculations and their correction queue
-- remain unchanged; live event intake and receipt delivery use separate jobs.
CREATE TABLE app_private.veo_maintenance_phases (
 phase text PRIMARY KEY CHECK(phase IN('salary','operations')),
 lease_owner uuid NOT NULL,
 leased_until timestamptz NOT NULL,
 next_run_at timestamptz NOT NULL,
 last_succeeded_at timestamptz,
 consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures BETWEEN 0 AND 4)
);
ALTER TABLE app_private.veo_maintenance_phases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.veo_maintenance_phases FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.veo_claim_maintenance_phase(p_phase text,p_owner uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='2s' SET lock_timeout='1s' AS $$
DECLARE acquired boolean; cadence interval;BEGIN
 IF p_phase IS NULL OR p_phase NOT IN('salary','operations') OR p_owner IS NULL THEN RAISE EXCEPTION 'Invalid maintenance phase';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('veo-maintenance-phase:'||p_phase,0)) THEN RETURN false;END IF;
 cadence:=CASE p_phase WHEN 'salary' THEN interval '2 minutes' ELSE interval '5 minutes' END;
 WITH claimed AS(
  INSERT INTO app_private.veo_maintenance_phases(phase,lease_owner,leased_until,next_run_at)
  VALUES(p_phase,p_owner,clock_timestamp()+interval '30 seconds',clock_timestamp()+cadence)
  ON CONFLICT(phase) DO UPDATE SET lease_owner=EXCLUDED.lease_owner,leased_until=EXCLUDED.leased_until,next_run_at=EXCLUDED.next_run_at
  WHERE app_private.veo_maintenance_phases.leased_until<=clock_timestamp() AND app_private.veo_maintenance_phases.next_run_at<=clock_timestamp()
  RETURNING phase
 ) SELECT true INTO acquired FROM claimed;
 RETURN coalesce(acquired,false);
END $$;

CREATE FUNCTION public.veo_finish_maintenance_phase(p_phase text,p_owner uuid,p_success boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='2s' SET lock_timeout='1s' AS $$
BEGIN
 IF p_phase IS NULL OR p_phase NOT IN('salary','operations') OR p_owner IS NULL OR p_success IS NULL THEN RAISE EXCEPTION 'Invalid maintenance completion';END IF;
 UPDATE app_private.veo_maintenance_phases SET
  leased_until=clock_timestamp(),
  next_run_at=CASE WHEN p_success THEN greatest(next_run_at,clock_timestamp())
   ELSE clock_timestamp()+make_interval(secs=>least(300,30*power(2,least(consecutive_failures+1,4)))::integer) END,
  last_succeeded_at=CASE WHEN p_success THEN clock_timestamp() ELSE last_succeeded_at END,
  consecutive_failures=CASE WHEN p_success THEN 0 ELSE least(4,consecutive_failures+1) END
 WHERE phase=p_phase AND lease_owner=p_owner AND leased_until>clock_timestamp();
 RETURN FOUND;
END $$;

CREATE FUNCTION public.veo_maintenance_phase_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='2s' AS $$
 WITH states AS(
  SELECT expected.phase,s.last_succeeded_at,s.next_run_at,coalesce(s.leased_until>now(),false) running,
   coalesce(s.consecutive_failures,0) failures,
   coalesce(s.last_succeeded_at>now()-expected.maximum_age AND s.consecutive_failures=0,false) healthy
  FROM(VALUES('salary'::text,interval '10 minutes'),('operations'::text,interval '20 minutes')) expected(phase,maximum_age)
  LEFT JOIN app_private.veo_maintenance_phases s USING(phase)
 ) SELECT jsonb_build_object('healthy',bool_and(healthy),'phases',jsonb_agg(to_jsonb(states) ORDER BY phase)) FROM states
$$;
REVOKE ALL ON FUNCTION public.veo_claim_maintenance_phase(text,uuid),public.veo_finish_maintenance_phase(text,uuid,boolean),public.veo_maintenance_phase_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_claim_maintenance_phase(text,uuid),public.veo_finish_maintenance_phase(text,uuid,boolean),public.veo_maintenance_phase_status() TO service_role;

-- These always-on upkeep functions lacked their own hoisted SQL deadlines.
ALTER FUNCTION public.veo_refresh_all_discipline() SET statement_timeout='5s';
ALTER FUNCTION public.veo_refresh_all_discipline() SET lock_timeout='1s';
ALTER FUNCTION public.veo_telegram_intake_maintenance() SET statement_timeout='5s';
ALTER FUNCTION public.veo_telegram_intake_maintenance() SET lock_timeout='1s';
ALTER FUNCTION public.veo_telegram_intake_maintenance() SET jit=off;

INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611210001','Durable bounded maintenance cadence, retry backoff and read-only phase health') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
