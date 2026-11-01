BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';

CREATE TABLE IF NOT EXISTS public.contact_profile_jobs (
    contact_id UUID PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','failed')),
    reason TEXT NOT NULL DEFAULT 'profile_open',
    requested_version INTEGER NOT NULL DEFAULT 1,
    working_version INTEGER,
    claim_token UUID,
    lease_until TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    source_cutoff_at TIMESTAMPTZ,
    scan_cursor TEXT,
    scan_started BOOLEAN NOT NULL DEFAULT FALSE,
    history_complete BOOLEAN NOT NULL DEFAULT FALSE,
    message_count INTEGER NOT NULL DEFAULT 0,
    analyzed_count INTEGER NOT NULL DEFAULT 0,
    partial_analysis JSONB NOT NULL DEFAULT '[]'::jsonb,
    error_message TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_profile_jobs_due ON public.contact_profile_jobs(next_attempt_at,requested_at)
    WHERE status IN ('queued','processing');

CREATE TABLE IF NOT EXISTS public.contact_profile_messages (
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,
    sender TEXT NOT NULL CHECK(sender IN ('customer','page','unknown')),
    text TEXT NOT NULL DEFAULT '',
    attachment_count INTEGER NOT NULL DEFAULT 0,
    image_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(contact_id,generation,message_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_profile_messages_time ON public.contact_profile_messages(contact_id,generation,sent_at,message_id);

CREATE TABLE IF NOT EXISTS public.contact_profile_snapshots (
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    source_cutoff_at TIMESTAMPTZ NOT NULL,
    message_count INTEGER NOT NULL,
    model TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(contact_id,generation)
);

CREATE TABLE IF NOT EXISTS public.contact_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL UNIQUE,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    description TEXT NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 500),
    total_minor BIGINT NOT NULL CHECK(total_minor>0 AND total_minor<=1000000000000),
    currency TEXT NOT NULL DEFAULT 'PHP' CHECK(currency ~ '^[A-Z]{3}$'),
    purchased_at TIMESTAMPTZ NOT NULL,
    reference TEXT,
    recorded_by UUID NOT NULL REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_purchases_scope ON public.contact_purchases(page_id,contact_id,purchased_at);

CREATE TABLE IF NOT EXISTS public.contact_verified_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL UNIQUE,
    page_id UUID NOT NULL REFERENCES public.pages(id) ON DELETE CASCADE,
    contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    purchase_id UUID REFERENCES public.contact_purchases(id),
    kind TEXT NOT NULL CHECK(kind IN ('deposit','balance','full','refund')),
    amount_minor BIGINT NOT NULL CHECK(amount_minor>0 AND amount_minor<=1000000000000),
    currency TEXT NOT NULL DEFAULT 'PHP' CHECK(currency ~ '^[A-Z]{3}$'),
    occurred_at TIMESTAMPTZ NOT NULL,
    reference TEXT NOT NULL CHECK(length(btrim(reference)) BETWEEN 3 AND 160),
    evidence_message_id TEXT,
    evidence_quote TEXT,
    note TEXT NOT NULL DEFAULT '',
    verified_by UUID NOT NULL REFERENCES public.users(id),
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    voided_at TIMESTAMPTZ,
    voided_by UUID REFERENCES public.users(id),
    void_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_payment_reference ON public.contact_verified_payments(page_id,lower(btrim(reference))) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contact_payments_scope ON public.contact_verified_payments(page_id,contact_id,occurred_at);
CREATE INDEX IF NOT EXISTS idx_outbound_events_contact_profile ON public.outbound_message_events(page_id,contact_id,sent_at);
CREATE INDEX IF NOT EXISTS idx_ad_stage_contact_profile ON public.ad_lead_stage_events(page_id,contact_id,recorded_at);

CREATE OR REPLACE FUNCTION public.enqueue_contact_profile(p_page_id UUID,p_contact_id UUID,p_reason TEXT DEFAULT 'profile_open')
RETURNS public.contact_profile_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result public.contact_profile_jobs;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.contacts WHERE id=p_contact_id AND page_id=p_page_id) THEN RAISE EXCEPTION 'Contact does not belong to Page'; END IF;
    IF p_reason NOT IN ('profile_open','stage_change','manual_refresh') THEN RAISE EXCEPTION 'Invalid refresh reason'; END IF;
    INSERT INTO public.contact_profile_jobs(contact_id,page_id,reason) VALUES(p_contact_id,p_page_id,p_reason)
    ON CONFLICT(contact_id) DO UPDATE SET
        requested_version=CASE WHEN p_reason='profile_open' AND contact_profile_jobs.status IN ('queued','processing','ready')
            THEN contact_profile_jobs.requested_version ELSE contact_profile_jobs.requested_version+1 END,
        status=CASE WHEN contact_profile_jobs.status='processing' AND contact_profile_jobs.lease_until>NOW() THEN 'processing'
            WHEN p_reason='profile_open' AND contact_profile_jobs.status='ready' THEN 'ready' ELSE 'queued' END,
        reason=EXCLUDED.reason,requested_at=NOW(),next_attempt_at=NOW(),attempt_count=0,error_message=NULL,updated_at=NOW()
    WHERE NOT(p_reason='profile_open' AND contact_profile_jobs.status IN ('queued','processing','ready'))
    RETURNING * INTO result;
    IF NOT FOUND THEN SELECT * INTO result FROM public.contact_profile_jobs WHERE contact_id=p_contact_id; END IF;
    RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.queue_profile_after_meta_stage()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
    IF NEW.applied AND (TG_OP='INSERT' OR NOT OLD.applied) THEN
        PERFORM public.enqueue_contact_profile(NEW.page_id,NEW.contact_id,'stage_change');
    END IF;
    RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS queue_profile_after_meta_stage ON public.messenger_lead_stage_events;
CREATE TRIGGER queue_profile_after_meta_stage AFTER INSERT OR UPDATE OF applied ON public.messenger_lead_stage_events
    FOR EACH ROW EXECUTE FUNCTION public.queue_profile_after_meta_stage();

CREATE OR REPLACE FUNCTION public.claim_contact_profile_jobs(p_limit INTEGER DEFAULT 2,p_contact_id UUID DEFAULT NULL)
RETURNS SETOF public.contact_profile_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Invalid profile batch size'; END IF;
    RETURN QUERY WITH due AS (
        SELECT j.contact_id FROM public.contact_profile_jobs j
        WHERE (p_contact_id IS NULL OR j.contact_id=p_contact_id) AND j.next_attempt_at<=NOW()
          AND (j.status='queued' OR (j.status='processing' AND j.lease_until<NOW()))
        ORDER BY j.requested_at LIMIT p_limit FOR UPDATE SKIP LOCKED
    ) UPDATE public.contact_profile_jobs j SET status='processing',claim_token=gen_random_uuid(),lease_until=NOW()+interval '4 minutes',
        working_version=j.requested_version,
        source_cutoff_at=CASE WHEN j.working_version IS DISTINCT FROM j.requested_version THEN NOW() ELSE coalesce(j.source_cutoff_at,NOW()) END,
        scan_cursor=CASE WHEN j.working_version IS DISTINCT FROM j.requested_version THEN NULL ELSE j.scan_cursor END,
        scan_started=CASE WHEN j.working_version IS DISTINCT FROM j.requested_version THEN FALSE ELSE j.scan_started END,
        history_complete=CASE WHEN j.working_version IS DISTINCT FROM j.requested_version THEN FALSE ELSE j.history_complete END,
        message_count=CASE WHEN j.working_version IS DISTINCT FROM j.requested_version THEN 0 ELSE j.message_count END,
        analyzed_count=CASE WHEN j.working_version IS DISTINCT FROM j.requested_version THEN 0 ELSE j.analyzed_count END,
        partial_analysis=CASE WHEN j.working_version IS DISTINCT FROM j.requested_version THEN '[]'::jsonb ELSE j.partial_analysis END,
        updated_at=NOW()
    FROM due WHERE j.contact_id=due.contact_id RETURNING j.*;
END; $$;

CREATE OR REPLACE FUNCTION public.save_contact_profile_progress(p_contact_id UUID,p_claim_token UUID,p_messages JSONB,p_progress JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.contact_profile_jobs; message JSONB;
BEGIN
    SELECT * INTO job FROM public.contact_profile_jobs WHERE contact_id=p_contact_id AND claim_token=p_claim_token AND status='processing' FOR UPDATE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    IF jsonb_typeof(p_messages)<>'array' OR jsonb_array_length(p_messages)>100 THEN RAISE EXCEPTION 'Invalid message batch'; END IF;
    FOR message IN SELECT * FROM jsonb_array_elements(p_messages) LOOP
        IF length(coalesce(message->>'id','')) NOT BETWEEN 1 AND 2000 OR length(coalesce(message->>'text',''))>50000
            OR message->>'sender' NOT IN ('customer','page','unknown') THEN RAISE EXCEPTION 'Invalid source message'; END IF;
        INSERT INTO public.contact_profile_messages(contact_id,page_id,generation,message_id,sent_at,sender,text,attachment_count,image_count)
        VALUES(job.contact_id,job.page_id,job.working_version,message->>'id',(message->>'at')::timestamptz,message->>'sender',coalesce(message->>'text',''),coalesce((message->>'attachments')::integer,0),coalesce((message->>'images')::integer,0))
        ON CONFLICT(contact_id,generation,message_id) DO UPDATE SET text=EXCLUDED.text,sender=EXCLUDED.sender,attachment_count=EXCLUDED.attachment_count,image_count=EXCLUDED.image_count;
    END LOOP;
    UPDATE public.contact_profile_jobs SET
        scan_cursor=CASE WHEN p_progress ? 'scan_cursor' THEN p_progress->>'scan_cursor' ELSE scan_cursor END,
        scan_started=CASE WHEN p_progress ? 'scan_started' THEN (p_progress->>'scan_started')::boolean ELSE scan_started END,
        history_complete=CASE WHEN p_progress ? 'history_complete' THEN (p_progress->>'history_complete')::boolean ELSE history_complete END,
        analyzed_count=CASE WHEN p_progress ? 'analyzed_count' THEN (p_progress->>'analyzed_count')::integer ELSE analyzed_count END,
        partial_analysis=coalesce(p_progress->'partial_analysis',partial_analysis),
        message_count=(SELECT count(*) FROM public.contact_profile_messages WHERE contact_id=job.contact_id AND generation=job.working_version),updated_at=NOW()
    WHERE contact_id=job.contact_id;
    RETURN TRUE;
END; $$;

CREATE OR REPLACE FUNCTION public.finish_contact_profile_job(p_contact_id UUID,p_claim_token UUID,p_model TEXT,p_payload JSONB DEFAULT NULL,p_error TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.contact_profile_jobs;
BEGIN
    SELECT * INTO job FROM public.contact_profile_jobs WHERE contact_id=p_contact_id AND claim_token=p_claim_token AND status='processing' FOR UPDATE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    IF p_payload IS NOT NULL THEN
        IF NOT job.history_complete OR job.analyzed_count<job.message_count THEN RAISE EXCEPTION 'Cannot publish an incomplete conversation'; END IF;
        INSERT INTO public.contact_profile_snapshots(contact_id,page_id,generation,source_cutoff_at,message_count,model,payload)
        VALUES(job.contact_id,job.page_id,job.working_version,job.source_cutoff_at,job.message_count,p_model,p_payload)
        ON CONFLICT(contact_id,generation) DO NOTHING;
        DELETE FROM public.contact_profile_messages WHERE contact_id=job.contact_id AND generation<job.working_version-1;
    END IF;
    UPDATE public.contact_profile_jobs SET
        status=CASE WHEN requested_version>working_version THEN 'queued' WHEN p_payload IS NOT NULL THEN 'ready'
            WHEN p_error IS NOT NULL AND attempt_count+1>=3 THEN 'failed' ELSE 'queued' END,
        attempt_count=CASE WHEN p_error IS NULL THEN 0 ELSE attempt_count+1 END,
        next_attempt_at=CASE WHEN p_error IS NULL THEN NOW() ELSE NOW()+interval '5 minutes' END,
        claim_token=NULL,lease_until=NULL,error_message=left(p_error,600),updated_at=NOW()
    WHERE contact_id=job.contact_id;
    RETURN TRUE;
END; $$;

CREATE OR REPLACE FUNCTION public.record_contact_purchase(p_page_id UUID,p_contact_id UUID,p_actor_id UUID,p_request_id UUID,p_description TEXT,p_total_minor BIGINT,p_currency TEXT,p_purchased_at TIMESTAMPTZ,p_reference TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result public.contact_purchases;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.contacts WHERE id=p_contact_id AND page_id=p_page_id) OR NOT EXISTS(SELECT 1 FROM public.user_pages WHERE page_id=p_page_id AND user_id=p_actor_id) THEN RAISE EXCEPTION 'Page membership required'; END IF;
    IF p_purchased_at IS NULL OR p_purchased_at>NOW()+interval '5 minutes' OR p_purchased_at<'2000-01-01' THEN RAISE EXCEPTION 'Invalid purchase date'; END IF;
    INSERT INTO public.contact_purchases(request_id,page_id,contact_id,description,total_minor,currency,purchased_at,reference,recorded_by)
    VALUES(p_request_id,p_page_id,p_contact_id,btrim(p_description),p_total_minor,upper(p_currency),p_purchased_at,nullif(btrim(p_reference),''),p_actor_id)
    ON CONFLICT(request_id) DO NOTHING RETURNING * INTO result;
    IF NOT FOUND THEN SELECT * INTO result FROM public.contact_purchases WHERE request_id=p_request_id AND page_id=p_page_id AND contact_id=p_contact_id AND recorded_by=p_actor_id; END IF;
    IF result.id IS NULL THEN RAISE EXCEPTION 'Request belongs to another contact'; END IF;
    RETURN to_jsonb(result);
END; $$;

CREATE OR REPLACE FUNCTION public.record_contact_verified_payment(p_page_id UUID,p_contact_id UUID,p_actor_id UUID,p_request_id UUID,p_purchase_id UUID,p_kind TEXT,p_amount_minor BIGINT,p_currency TEXT,p_occurred_at TIMESTAMPTZ,p_reference TEXT,p_message_id TEXT DEFAULT NULL,p_note TEXT DEFAULT '')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result public.contact_verified_payments; quote TEXT;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.contacts WHERE id=p_contact_id AND page_id=p_page_id) OR NOT EXISTS(SELECT 1 FROM public.user_pages WHERE page_id=p_page_id AND user_id=p_actor_id) THEN RAISE EXCEPTION 'Page membership required'; END IF;
    IF p_occurred_at IS NULL OR p_occurred_at>NOW()+interval '5 minutes' OR p_occurred_at<'2000-01-01' OR length(p_note)>3000 THEN RAISE EXCEPTION 'Invalid payment details'; END IF;
    IF p_purchase_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contact_purchases WHERE id=p_purchase_id AND page_id=p_page_id AND contact_id=p_contact_id AND currency=upper(p_currency)) THEN RAISE EXCEPTION 'Purchase or currency does not match contact'; END IF;
    IF p_message_id IS NOT NULL THEN
        SELECT left(text,2000) INTO quote FROM public.contact_profile_messages WHERE contact_id=p_contact_id AND page_id=p_page_id AND message_id=p_message_id ORDER BY generation DESC LIMIT 1;
        IF NOT FOUND THEN RAISE EXCEPTION 'Evidence message not found'; END IF;
    END IF;
    INSERT INTO public.contact_verified_payments(request_id,page_id,contact_id,purchase_id,kind,amount_minor,currency,occurred_at,reference,evidence_message_id,evidence_quote,note,verified_by)
    VALUES(p_request_id,p_page_id,p_contact_id,p_purchase_id,p_kind,p_amount_minor,upper(p_currency),p_occurred_at,btrim(p_reference),p_message_id,quote,p_note,p_actor_id)
    ON CONFLICT(request_id) DO NOTHING RETURNING * INTO result;
    IF NOT FOUND THEN SELECT * INTO result FROM public.contact_verified_payments WHERE request_id=p_request_id AND page_id=p_page_id AND contact_id=p_contact_id AND verified_by=p_actor_id; END IF;
    IF result.id IS NULL THEN RAISE EXCEPTION 'Request belongs to another contact'; END IF;
    RETURN to_jsonb(result);
END; $$;

CREATE OR REPLACE FUNCTION public.void_contact_verified_payment(p_page_id UUID,p_contact_id UUID,p_payment_id UUID,p_actor_id UUID,p_reason TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.user_pages WHERE page_id=p_page_id AND user_id=p_actor_id) OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Membership and correction reason required'; END IF;
    UPDATE public.contact_verified_payments SET voided_at=NOW(),voided_by=p_actor_id,void_reason=btrim(p_reason)
    WHERE id=p_payment_id AND page_id=p_page_id AND contact_id=p_contact_id AND voided_at IS NULL;
    RETURN FOUND;
END; $$;

CREATE OR REPLACE FUNCTION public.get_contact_finance_records(p_page_id UUID,p_contact_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
    SELECT jsonb_build_object(
        'purchases',coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('recorded_by_name',u.name) ORDER BY p.purchased_at,p.id)
            FROM public.contact_purchases p JOIN public.users u ON u.id=p.recorded_by WHERE p.page_id=p_page_id AND p.contact_id=p_contact_id),'[]'::jsonb),
        'payments',coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('verified_by_name',u.name) ORDER BY p.occurred_at,p.id)
            FROM public.contact_verified_payments p JOIN public.users u ON u.id=p.verified_by WHERE p.page_id=p_page_id AND p.contact_id=p_contact_id),'[]'::jsonb)
    );
$$;

ALTER TABLE public.contact_profile_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_profile_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_profile_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_verified_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_profile_jobs,public.contact_profile_messages,public.contact_profile_snapshots,public.contact_purchases,public.contact_verified_payments FROM anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.contact_profile_jobs,public.contact_profile_messages,public.contact_profile_snapshots TO service_role;
GRANT SELECT ON public.contact_purchases,public.contact_verified_payments TO service_role;
REVOKE ALL ON FUNCTION public.enqueue_contact_profile(UUID,UUID,TEXT),public.queue_profile_after_meta_stage(),public.claim_contact_profile_jobs(INTEGER,UUID),
    public.save_contact_profile_progress(UUID,UUID,JSONB,JSONB),public.finish_contact_profile_job(UUID,UUID,TEXT,JSONB,TEXT),
    public.record_contact_purchase(UUID,UUID,UUID,UUID,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT),
    public.record_contact_verified_payment(UUID,UUID,UUID,UUID,UUID,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT),
    public.void_contact_verified_payment(UUID,UUID,UUID,UUID,TEXT),public.get_contact_finance_records(UUID,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_contact_profile(UUID,UUID,TEXT),public.claim_contact_profile_jobs(INTEGER,UUID),
    public.save_contact_profile_progress(UUID,UUID,JSONB,JSONB),public.finish_contact_profile_job(UUID,UUID,TEXT,JSONB,TEXT),
    public.record_contact_purchase(UUID,UUID,UUID,UUID,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT),
    public.record_contact_verified_payment(UUID,UUID,UUID,UUID,UUID,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT),
    public.void_contact_verified_payment(UUID,UUID,UUID,UUID,TEXT),public.get_contact_finance_records(UUID,UUID) TO service_role;
-- Existing observed Meta decisions receive the same review as future changes.
INSERT INTO public.contact_profile_jobs(contact_id,page_id,reason)
SELECT DISTINCT contact_id,page_id,'stage_change' FROM public.messenger_lead_stage_events
WHERE applied AND observed_at>NOW()-interval '7 days'
ON CONFLICT(contact_id) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
