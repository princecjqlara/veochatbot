BEGIN;
SET LOCAL lock_timeout='5s';
-- Only a trusted SQL repair session sets this transaction-local flag. It does
-- not change Page settings or suppress summaries for later live stage changes.
CREATE OR REPLACE FUNCTION public.queue_profile_after_meta_stage()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
    IF current_setting('app.historical_lead_repair',true)='deterministic_only' THEN RETURN NEW; END IF;
    IF NEW.applied AND (TG_OP='INSERT' OR NOT OLD.applied) THEN
        PERFORM public.enqueue_contact_profile(NEW.page_id,NEW.contact_id,'stage_change');
    END IF;
    RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.queue_profile_after_meta_stage() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
