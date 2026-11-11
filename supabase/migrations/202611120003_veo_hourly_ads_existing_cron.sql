BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE meta_ads_credentials ADD COLUMN next_scheduled_refresh_at timestamptz;
ALTER TABLE meta_ads_credentials ADD COLUMN scheduled_refresh_started_at timestamptz;
ALTER TABLE meta_ads_credentials ADD COLUMN scheduled_refresh_finished_at timestamptz;
ALTER TABLE meta_ads_credentials ADD COLUMN scheduled_refresh_status text CHECK(scheduled_refresh_status IN('running','complete','incomplete','failed','skipped'));
CREATE FUNCTION veo_claim_scheduled_meta_ads_refresh(p_user uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE claimed boolean;BEGIN
 WITH changed AS(
  UPDATE meta_ads_credentials SET scheduled_refresh_started_at=clock_timestamp(),next_scheduled_refresh_at=clock_timestamp()+interval '1 hour',scheduled_refresh_status='running'
  WHERE user_id=p_user AND(token_expires_at IS NULL OR token_expires_at>clock_timestamp())
  AND(next_scheduled_refresh_at IS NULL OR next_scheduled_refresh_at<=clock_timestamp())
  AND(last_synced_at IS NULL OR last_synced_at<=clock_timestamp()-interval '1 hour')
  AND(refresh_lease_until IS NULL OR refresh_lease_until<=clock_timestamp()) RETURNING user_id
 ) SELECT true INTO claimed FROM changed;
 RETURN coalesce(claimed,false);
END $$;
REVOKE ALL ON FUNCTION veo_claim_scheduled_meta_ads_refresh(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_claim_scheduled_meta_ads_refresh(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
