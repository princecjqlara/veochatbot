BEGIN;
CREATE TABLE veo_background_job_leases(
 job text PRIMARY KEY CHECK(job IN('workspace','contact-profiles')),
 lease_owner uuid NOT NULL,leased_until timestamptz NOT NULL
);
ALTER TABLE veo_background_job_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_background_job_leases FROM PUBLIC,anon,authenticated;
GRANT SELECT ON veo_background_job_leases TO service_role;
CREATE FUNCTION veo_claim_background_job(p_job text,p_owner uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE acquired boolean;BEGIN
 IF p_job NOT IN('workspace','contact-profiles') OR p_owner IS NULL THEN RAISE EXCEPTION 'Invalid background job';END IF;
 WITH claimed AS(
  INSERT INTO veo_background_job_leases(job,lease_owner,leased_until) VALUES(p_job,p_owner,clock_timestamp()+interval '330 seconds')
  ON CONFLICT(job) DO UPDATE SET lease_owner=EXCLUDED.lease_owner,leased_until=EXCLUDED.leased_until
  WHERE veo_background_job_leases.leased_until<=clock_timestamp() RETURNING job
 ) SELECT true INTO acquired FROM claimed;
 RETURN coalesce(acquired,false);
END $$;
CREATE FUNCTION veo_release_background_job(p_job text,p_owner uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 DELETE FROM veo_background_job_leases WHERE job=p_job AND lease_owner=p_owner;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION veo_claim_background_job(text,uuid),veo_release_background_job(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_claim_background_job(text,uuid),veo_release_background_job(text,uuid) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611090006','Shared leases prevent duplicate cron maintenance across serverless instances') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
