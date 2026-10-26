-- Additive source evidence and live cohort reporting. No inferred ad assignments.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.ad_tracking_settings (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.ad_tracking_settings(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ad_contact_sources (
    contact_id UUID PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    first_inquiry_at TIMESTAMPTZ,
    first_message_id TEXT,
    first_event_key TEXT,
    inquiry_basis TEXT NOT NULL DEFAULT 'awaiting_inquiry',
    origin_ad_id TEXT,
    origin_evidence_key TEXT,
    attribution_status TEXT NOT NULL DEFAULT 'unknown' CHECK(attribution_status IN ('unknown','verified_inline','conflicting_sources')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK(origin_ad_id IS NULL OR origin_ad_id ~ '^[0-9]+$')
);
CREATE INDEX IF NOT EXISTS idx_ad_contact_sources_page_first ON public.ad_contact_sources(page_id,first_inquiry_at,origin_ad_id);

CREATE TABLE IF NOT EXISTS public.ad_referral_events (
    event_key TEXT PRIMARY KEY,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES public.contacts(id) ON DELETE CASCADE,
    psid TEXT NOT NULL,
    event_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    event_kind TEXT NOT NULL,
    message_id TEXT,
    ad_id TEXT,
    referral JSONB NOT NULL DEFAULT '{}'::jsonb,
    CHECK(ad_id IS NULL OR ad_id ~ '^[0-9]+$')
);
CREATE INDEX IF NOT EXISTS idx_ad_referral_events_page_time ON public.ad_referral_events(page_id,event_at);
CREATE INDEX IF NOT EXISTS idx_ad_referral_events_contact ON public.ad_referral_events(contact_id,event_at);
CREATE INDEX IF NOT EXISTS idx_ad_referral_events_unlinked ON public.ad_referral_events(page_id,psid) WHERE contact_id IS NULL;

CREATE TABLE IF NOT EXISTS public.ad_source_catalog (
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    ad_id TEXT NOT NULL CHECK(ad_id ~ '^[0-9]+$'),
    ad_name TEXT,
    ad_title TEXT,
    post_id TEXT,
    photo_url TEXT,
    video_url TEXT,
    creative_id TEXT,
    creative_name TEXT,
    campaign_id TEXT,
    campaign_name TEXT,
    adset_id TEXT,
    adset_name TEXT,
    metadata_source TEXT NOT NULL DEFAULT 'webhook_context',
    metadata_checked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(page_id,ad_id)
);

CREATE TABLE IF NOT EXISTS public.ad_lead_stage_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    previous_stage TEXT,
    stage TEXT NOT NULL,
    source TEXT,
    stage_timestamp TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_ad_lead_stage_events_page_time ON public.ad_lead_stage_events(page_id,recorded_at);

CREATE OR REPLACE FUNCTION public.record_ad_lead_stage_event() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW.pipeline_stage IS NOT DISTINCT FROM OLD.pipeline_stage
       AND NEW.pipeline_stage_source IS NOT DISTINCT FROM OLD.pipeline_stage_source THEN RETURN NEW; END IF;
    INSERT INTO ad_lead_stage_events(page_id,contact_id,previous_stage,stage,source,stage_timestamp)
    VALUES(NEW.page_id,NEW.id,CASE WHEN TG_OP='UPDATE' THEN OLD.pipeline_stage END,
           NEW.pipeline_stage,NEW.pipeline_stage_source,NEW.pipeline_stage_updated_at);
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS record_ad_lead_stage_event ON public.contacts;
CREATE TRIGGER record_ad_lead_stage_event AFTER INSERT OR UPDATE OF pipeline_stage,pipeline_stage_source
ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.record_ad_lead_stage_event();

CREATE OR REPLACE FUNCTION public.record_contact_ad_event(
    p_page_id UUID,p_contact_id UUID,p_event_key TEXT,p_event_at TIMESTAMPTZ,
    p_event_kind TEXT,p_is_inquiry BOOLEAN,p_message_id TEXT DEFAULT NULL,
    p_referral JSONB DEFAULT '{}'::jsonb,p_prior_first_at TIMESTAMPTZ DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
    original ad_contact_sources%ROWTYPE;
    ad TEXT := CASE WHEN p_referral->>'ad_id' ~ '^[0-9]+$' THEN p_referral->>'ad_id' END;
    first_at TIMESTAMPTZ;
    context JSONB := COALESCE(p_referral->'ads_context_data','{}'::jsonb);
    contact_psid TEXT;
BEGIN
    IF p_event_key IS NULL OR length(p_event_key)>200 OR p_event_at IS NULL OR p_event_at>clock_timestamp()+interval '1 minute'
       OR p_event_kind NOT IN ('message','postback','referral') OR octet_length(p_referral::text)>16384 THEN
        RAISE EXCEPTION 'Invalid source event';
    END IF;
    SELECT psid INTO contact_psid FROM contacts WHERE id=p_contact_id AND page_id=p_page_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Contact outside Page'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_contact_id::text,27001));
    UPDATE ad_referral_events SET contact_id=p_contact_id WHERE page_id=p_page_id AND psid=contact_psid AND contact_id IS NULL;
    SELECT * INTO original FROM ad_contact_sources WHERE contact_id=p_contact_id;
    IF NOT FOUND THEN
        -- Prior CRM/history evidence prevents a returning ad click becoming a new acquisition.
        first_at := CASE WHEN p_prior_first_at<p_event_at THEN p_prior_first_at
                         WHEN p_is_inquiry THEN p_event_at END;
        INSERT INTO ad_contact_sources(contact_id,page_id,first_inquiry_at,first_message_id,first_event_key,inquiry_basis)
        VALUES(p_contact_id,p_page_id,first_at,
            CASE WHEN first_at=p_event_at THEN p_message_id END,
            CASE WHEN first_at=p_event_at THEN p_event_key END,
            CASE WHEN first_at<p_event_at THEN 'legacy_recorded'
                 WHEN p_is_inquiry THEN 'live_'||p_event_kind ELSE 'awaiting_inquiry' END)
        RETURNING * INTO original;
    END IF;
    IF p_referral<>'{}'::jsonb THEN
        INSERT INTO ad_referral_events(event_key,page_id,contact_id,psid,event_at,event_kind,message_id,ad_id,referral)
        VALUES(p_event_key,p_page_id,p_contact_id,contact_psid,p_event_at,p_event_kind,p_message_id,ad,p_referral)
        ON CONFLICT(event_key) DO NOTHING;
    END IF;
    IF ad IS NOT NULL THEN
        INSERT INTO ad_source_catalog AS catalog(page_id,ad_id,ad_title,post_id,photo_url,video_url)
        VALUES(p_page_id,ad,left(context->>'ad_title',500),left(context->>'post_id',100),context->>'photo_url',context->>'video_url')
        ON CONFLICT(page_id,ad_id) DO UPDATE SET
            ad_title=COALESCE(catalog.ad_title,EXCLUDED.ad_title),post_id=COALESCE(catalog.post_id,EXCLUDED.post_id),
            photo_url=COALESCE(catalog.photo_url,EXCLUDED.photo_url),video_url=COALESCE(catalog.video_url,EXCLUDED.video_url),updated_at=clock_timestamp();
    END IF;
    IF NOT p_is_inquiry THEN RETURN; END IF; -- a thread-open/referral is not a lead
    IF original.first_inquiry_at IS NULL OR p_event_at<original.first_inquiry_at THEN
        -- A delayed earlier inquiry replaces the later event, clearing its attribution.
        UPDATE ad_contact_sources SET first_inquiry_at=p_event_at,first_message_id=p_message_id,first_event_key=p_event_key,
            inquiry_basis='live_'||p_event_kind,origin_ad_id=NULL,origin_evidence_key=NULL,attribution_status='unknown',updated_at=clock_timestamp()
        WHERE contact_id=p_contact_id RETURNING * INTO original;
    END IF;
    IF p_event_at=original.first_inquiry_at AND ad IS NOT NULL AND
       (original.first_event_key=p_event_key OR
        original.first_message_id IS NOT NULL AND original.first_message_id=p_message_id) THEN
        IF original.attribution_status='conflicting_sources' THEN RETURN; END IF;
        IF original.origin_ad_id IS NOT NULL AND original.origin_ad_id<>ad THEN
            UPDATE ad_contact_sources SET origin_ad_id=NULL,origin_evidence_key=NULL,attribution_status='conflicting_sources',updated_at=clock_timestamp()
            WHERE contact_id=p_contact_id;
        ELSE
            UPDATE ad_contact_sources SET origin_ad_id=ad,origin_evidence_key=p_event_key,attribution_status='verified_inline',updated_at=clock_timestamp()
            WHERE contact_id=p_contact_id;
        END IF;
    END IF;
END $$;

-- A bare thread-open is retained without creating a CRM lead or sending a welcome.
CREATE OR REPLACE FUNCTION public.record_standalone_ad_referral(
    p_page_id UUID,p_psid TEXT,p_event_key TEXT,p_event_at TIMESTAMPTZ,p_referral JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
    contact UUID;
    ad TEXT := CASE WHEN p_referral->>'ad_id' ~ '^[0-9]+$' THEN p_referral->>'ad_id' END;
    context JSONB := COALESCE(p_referral->'ads_context_data','{}'::jsonb);
BEGIN
    IF p_psid IS NULL OR length(p_psid)>100 OR p_event_key IS NULL OR length(p_event_key)>200
       OR p_event_at IS NULL OR p_event_at>clock_timestamp()+interval '1 minute' OR octet_length(p_referral::text)>16384 THEN RAISE EXCEPTION 'Invalid referral'; END IF;
    SELECT id INTO contact FROM contacts WHERE page_id=p_page_id AND psid=p_psid;
    INSERT INTO ad_referral_events(event_key,page_id,contact_id,psid,event_at,event_kind,ad_id,referral)
    VALUES(p_event_key,p_page_id,contact,p_psid,p_event_at,'referral',ad,p_referral) ON CONFLICT(event_key) DO NOTHING;
    IF ad IS NOT NULL THEN
        INSERT INTO ad_source_catalog AS a(page_id,ad_id,ad_title,post_id,photo_url,video_url)
        VALUES(p_page_id,ad,left(context->>'ad_title',500),left(context->>'post_id',100),context->>'photo_url',context->>'video_url')
        ON CONFLICT(page_id,ad_id) DO UPDATE SET ad_title=COALESCE(a.ad_title,EXCLUDED.ad_title),post_id=COALESCE(a.post_id,EXCLUDED.post_id),
            photo_url=COALESCE(a.photo_url,EXCLUDED.photo_url),video_url=COALESCE(a.video_url,EXCLUDED.video_url),updated_at=clock_timestamp();
    END IF;
END $$;

-- An original inquiry cohort, with an explicit legacy-date fallback for old CRM records.
CREATE OR REPLACE VIEW public.ad_lead_cohorts AS
SELECT c.id,c.page_id,c.psid,c.name,c.pipeline_stage,c.pipeline_stage_source,c.pipeline_stage_updated_at,
       CASE WHEN s.contact_id IS NOT NULL THEN s.first_inquiry_at ELSE c.first_interaction_at END AS first_inquiry_at,
       COALESCE(s.inquiry_basis,'legacy_recorded') AS inquiry_basis,
       s.origin_ad_id AS ad_id,COALESCE(s.attribution_status,'unknown') AS attribution_status,
       s.first_message_id,s.origin_evidence_key
FROM public.contacts c LEFT JOIN public.ad_contact_sources s ON s.contact_id=c.id AND s.page_id=c.page_id;

CREATE OR REPLACE FUNCTION public.get_ad_lead_quality(p_page_id UUID,p_from TIMESTAMPTZ DEFAULT NULL,p_to TIMESTAMPTZ DEFAULT now())
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH cohort AS MATERIALIZED (
    SELECT * FROM ad_lead_cohorts WHERE page_id=p_page_id AND first_inquiry_at IS NOT NULL
    AND (p_from IS NULL OR first_inquiry_at>=p_from) AND first_inquiry_at<p_to
), grouped AS (
    SELECT ad_id,count(*) AS inquiries,
        count(*) FILTER(WHERE pipeline_stage='qualified') AS qualified,
        count(*) FILTER(WHERE pipeline_stage='not_qualified') AS not_qualified,
        count(*) FILTER(WHERE pipeline_stage='order_created') AS order_created,
        count(*) FILTER(WHERE pipeline_stage='converted') AS crm_converted,
        count(*) FILTER(WHERE pipeline_stage='opted_out') AS opted_out,
        count(*) FILTER(WHERE pipeline_stage IN ('new','engaged','collecting_details') OR pipeline_stage IS NULL) AS pending,
        count(*) FILTER(WHERE inquiry_basis='legacy_recorded') AS legacy_dates,
        count(*) FILTER(WHERE attribution_status='conflicting_sources') AS conflicting_sources
    FROM cohort GROUP BY ad_id
), rows AS (
    SELECT g.*,a.ad_name,a.ad_title,a.creative_id,a.creative_name,a.post_id,a.photo_url,a.video_url,
        a.campaign_id,a.campaign_name,a.adset_id,a.adset_name,a.metadata_source,a.metadata_checked_at,
        g.not_qualified::numeric/NULLIF(g.inquiries,0) AS not_qualified_rate,
        g.not_qualified::numeric/NULLIF(g.qualified+g.not_qualified,0) AS not_qualified_assessed_rate
    FROM grouped g LEFT JOIN ad_source_catalog a ON a.page_id=p_page_id AND a.ad_id=g.ad_id
)
SELECT jsonb_build_object(
    'generated_at',now(),'tracking_started_at',(SELECT started_at FROM ad_tracking_settings WHERE singleton),
    'inquiries',(SELECT count(*) FROM cohort),'attributed',(SELECT count(*) FROM cohort WHERE ad_id IS NOT NULL),
    'not_qualified',(SELECT count(*) FROM cohort WHERE pipeline_stage='not_qualified'),
    'qualified',(SELECT count(*) FROM cohort WHERE pipeline_stage='qualified'),
    'pending',(SELECT count(*) FROM cohort WHERE pipeline_stage IN ('new','engaged','collecting_details') OR pipeline_stage IS NULL),
    'legacy_dates',(SELECT count(*) FROM cohort WHERE inquiry_basis='legacy_recorded'),
    'without_inquiry_timestamp',(SELECT count(*) FROM ad_lead_cohorts WHERE page_id=p_page_id AND first_inquiry_at IS NULL),
    'rows',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.not_qualified DESC,r.inquiries DESC) FROM rows r),'[]'::jsonb)
);
$$;

CREATE OR REPLACE FUNCTION public.get_ad_lead_contacts(
    p_page_id UUID,p_from TIMESTAMPTZ DEFAULT NULL,p_to TIMESTAMPTZ DEFAULT now(),p_ad_id TEXT DEFAULT NULL,
    p_unknown BOOLEAN DEFAULT FALSE,p_stage TEXT DEFAULT NULL,p_limit INTEGER DEFAULT 25,p_offset INTEGER DEFAULT 0
) RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH selected AS MATERIALIZED (
    SELECT * FROM ad_lead_cohorts WHERE page_id=p_page_id AND first_inquiry_at IS NOT NULL
    AND (p_from IS NULL OR first_inquiry_at>=p_from) AND first_inquiry_at<p_to
    AND (NOT p_unknown OR ad_id IS NULL) AND (p_ad_id IS NULL OR ad_id=p_ad_id)
    AND (p_stage IS NULL OR pipeline_stage=p_stage)
), limited AS (
    SELECT * FROM selected ORDER BY first_inquiry_at DESC,id LIMIT LEAST(GREATEST(p_limit,1),100) OFFSET GREATEST(p_offset,0)
)
SELECT jsonb_build_object('total',(SELECT count(*) FROM selected),'contacts',COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM limited l),'[]'::jsonb));
$$;

ALTER TABLE public.ad_tracking_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_contact_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_referral_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_source_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_lead_stage_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ad_tracking_settings,public.ad_contact_sources,public.ad_referral_events,public.ad_source_catalog,public.ad_lead_stage_events,public.ad_lead_cohorts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.ad_tracking_settings,public.ad_contact_sources,public.ad_referral_events,public.ad_source_catalog,public.ad_lead_stage_events TO service_role;
GRANT SELECT ON public.ad_lead_cohorts TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.ad_lead_stage_events_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.record_ad_lead_stage_event() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_standalone_ad_referral(UUID,TEXT,TEXT,TIMESTAMPTZ,JSONB) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_contact_ad_event(UUID,UUID,TEXT,TIMESTAMPTZ,TEXT,BOOLEAN,TEXT,JSONB,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_ad_lead_quality(UUID,TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_ad_lead_contacts(UUID,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,BOOLEAN,TEXT,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_contact_ad_event(UUID,UUID,TEXT,TIMESTAMPTZ,TEXT,BOOLEAN,TEXT,JSONB,TIMESTAMPTZ),
 public.record_standalone_ad_referral(UUID,TEXT,TEXT,TIMESTAMPTZ,JSONB),
 public.get_ad_lead_quality(UUID,TIMESTAMPTZ,TIMESTAMPTZ),
 public.get_ad_lead_contacts(UUID,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,BOOLEAN,TEXT,INTEGER,INTEGER) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('20261027_001','First-inquiry ad evidence, qualification event audit, and live ad lead quality') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
