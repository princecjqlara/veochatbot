BEGIN;
ALTER TABLE public.ad_source_catalog ADD COLUMN IF NOT EXISTS post_permalink_url TEXT;
ALTER TABLE public.ad_source_catalog ADD COLUMN IF NOT EXISTS ad_account_id TEXT;
ALTER TABLE public.ad_source_catalog ADD COLUMN IF NOT EXISTS ad_status TEXT;
ALTER TABLE public.ad_source_catalog ADD COLUMN IF NOT EXISTS metadata_status TEXT NOT NULL DEFAULT 'webhook_only';
ALTER TABLE public.ad_source_catalog ADD COLUMN IF NOT EXISTS metadata_error_code INTEGER;

-- Inventory is separate from first-inquiry cohorts: seeing an ad/referral never
-- fabricates an originating ad for an old or unattributed contact.
CREATE OR REPLACE FUNCTION public.get_visible_ad_catalog(p_page_ids UUID[],p_from TIMESTAMPTZ,p_to TIMESTAMPTZ)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH activity AS (
 SELECT page_id,ad_id,count(*) AS referral_events,count(DISTINCT psid) AS referral_contacts,max(event_at) AS last_referral_at
 FROM ad_referral_events WHERE page_id=ANY(p_page_ids) AND ad_id IS NOT NULL
 AND (p_from IS NULL OR event_at>=p_from) AND event_at<p_to GROUP BY page_id,ad_id
)
SELECT COALESCE(jsonb_agg(to_jsonb(a)||jsonb_build_object('referral_events',COALESCE(r.referral_events,0),
 'referral_contacts',COALESCE(r.referral_contacts,0),'last_referral_at',r.last_referral_at) ORDER BY a.page_id,a.ad_id),'[]'::jsonb)
FROM ad_source_catalog a LEFT JOIN activity r ON r.page_id=a.page_id AND r.ad_id=a.ad_id
WHERE a.page_id=ANY(p_page_ids) AND cardinality(p_page_ids)<=200;
$$;

CREATE OR REPLACE FUNCTION public.save_ad_catalog_metadata(p_records JSONB)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n INTEGER;
BEGIN
 IF jsonb_typeof(p_records)<>'array' OR jsonb_array_length(p_records)>100 THEN RAISE EXCEPTION 'Invalid ad metadata batch'; END IF;
 INSERT INTO ad_source_catalog AS old(page_id,ad_id,ad_name,post_id,photo_url,video_url,creative_id,creative_name,campaign_id,campaign_name,adset_id,adset_name,post_permalink_url,ad_account_id,ad_status,metadata_source,metadata_status,metadata_error_code,metadata_checked_at)
 SELECT r.page_id,r.ad_id,NULLIF(r.ad_name,''),NULLIF(r.post_id,''),NULLIF(r.photo_url,''),NULLIF(r.video_url,''),r.creative_id,r.creative_name,r.campaign_id,r.campaign_name,r.adset_id,r.adset_name,r.post_permalink_url,r.ad_account_id,r.ad_status,COALESCE(r.metadata_source,'webhook_context'),COALESCE(r.metadata_status,'webhook_only'),r.metadata_error_code,clock_timestamp()
 FROM jsonb_to_recordset(p_records) r(page_id UUID,ad_id TEXT,ad_name TEXT,post_id TEXT,photo_url TEXT,video_url TEXT,creative_id TEXT,creative_name TEXT,campaign_id TEXT,campaign_name TEXT,adset_id TEXT,adset_name TEXT,post_permalink_url TEXT,ad_account_id TEXT,ad_status TEXT,metadata_source TEXT,metadata_status TEXT,metadata_error_code INTEGER)
 ON CONFLICT(page_id,ad_id) DO UPDATE SET ad_name=COALESCE(EXCLUDED.ad_name,old.ad_name),post_id=COALESCE(EXCLUDED.post_id,old.post_id),
 photo_url=COALESCE(EXCLUDED.photo_url,old.photo_url),video_url=COALESCE(EXCLUDED.video_url,old.video_url),creative_id=COALESCE(EXCLUDED.creative_id,old.creative_id),creative_name=COALESCE(EXCLUDED.creative_name,old.creative_name),
 campaign_id=COALESCE(EXCLUDED.campaign_id,old.campaign_id),campaign_name=COALESCE(EXCLUDED.campaign_name,old.campaign_name),adset_id=COALESCE(EXCLUDED.adset_id,old.adset_id),adset_name=COALESCE(EXCLUDED.adset_name,old.adset_name),
 post_permalink_url=COALESCE(EXCLUDED.post_permalink_url,old.post_permalink_url),ad_account_id=COALESCE(EXCLUDED.ad_account_id,old.ad_account_id),ad_status=COALESCE(EXCLUDED.ad_status,old.ad_status),
 metadata_source=CASE WHEN EXCLUDED.metadata_status IN('available','page_post') THEN EXCLUDED.metadata_source ELSE old.metadata_source END,
 metadata_status=EXCLUDED.metadata_status,metadata_error_code=EXCLUDED.metadata_error_code,metadata_checked_at=clock_timestamp(),updated_at=clock_timestamp();
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.get_visible_ad_catalog(UUID[],TIMESTAMPTZ,TIMESTAMPTZ),public.save_ad_catalog_metadata(JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_visible_ad_catalog(UUID[],TIMESTAMPTZ,TIMESTAMPTZ),public.save_ad_catalog_metadata(JSONB) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('20261028_002','Visible ad inventory and verified creative metadata without inferred lead attribution') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
