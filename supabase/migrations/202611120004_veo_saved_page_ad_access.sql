BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE meta_ads_credentials ADD COLUMN credential_origin text NOT NULL DEFAULT 'owner_oauth' CHECK(credential_origin IN('owner_oauth','connected_page'));
ALTER TABLE meta_ads_credentials ADD COLUMN source_page_id uuid REFERENCES pages(id) ON DELETE SET NULL;
CREATE TABLE veo_ad_source_discovery(
 user_id uuid PRIMARY KEY REFERENCES users(id),last_attempt_at timestamptz NOT NULL,next_attempt_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN('checking','connected','failed')),last_error text
);
ALTER TABLE veo_ad_source_discovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_ad_source_discovery FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_ad_source_discovery TO service_role;
CREATE FUNCTION veo_claim_page_ads_discovery(p_user uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE claimed boolean;BEGIN
 IF NOT EXISTS(SELECT 1 FROM veo_accounts a JOIN users u ON u.id=a.user_id AND u.is_active JOIN veo_tenants t ON t.id=a.tenant_id AND t.owner_id=a.user_id AND t.launch_at IS NOT NULL WHERE a.user_id=p_user AND a.active AND a.role='owner') THEN RAISE EXCEPTION 'Workspace Owner access is required' USING ERRCODE='42501';END IF;
 WITH changed AS(INSERT INTO veo_ad_source_discovery(user_id,last_attempt_at,next_attempt_at,status)
 VALUES(p_user,clock_timestamp(),clock_timestamp()+interval '1 hour','checking')
 ON CONFLICT(user_id) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at,next_attempt_at=EXCLUDED.next_attempt_at,status='checking',last_error=NULL
 WHERE veo_ad_source_discovery.next_attempt_at<=clock_timestamp() RETURNING user_id) SELECT true INTO claimed FROM changed;
 RETURN coalesce(claimed,false);
END $$;
CREATE FUNCTION veo_page_ads_discovery_candidates() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT t.owner_id FROM veo_tenants t JOIN veo_accounts a ON a.user_id=t.owner_id AND a.active AND a.role='owner' JOIN users u ON u.id=a.user_id AND u.is_active
 LEFT JOIN meta_ads_credentials c ON c.user_id=t.owner_id LEFT JOIN veo_ad_source_discovery d ON d.user_id=t.owner_id
 WHERE t.launch_at IS NOT NULL AND c.user_id IS NULL AND(d.user_id IS NULL OR d.next_attempt_at<=now())
 AND EXISTS(SELECT 1 FROM user_pages up JOIN pages p ON p.id=up.page_id AND p.veo_enabled AND p.veo_tenant_id=t.id WHERE up.user_id=t.owner_id AND coalesce(p.access_token,'')<>'') LIMIT 20
$$;
REVOKE ALL ON FUNCTION veo_claim_page_ads_discovery(uuid),veo_page_ads_discovery_candidates() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_claim_page_ads_discovery(uuid),veo_page_ads_discovery_candidates() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
