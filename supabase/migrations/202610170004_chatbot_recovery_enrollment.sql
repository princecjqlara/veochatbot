BEGIN;
-- Enabling a bot also enables missed-inbound recovery, starting with fresh
-- messages. Turning it off disables recovery without clearing contact holds.
CREATE OR REPLACE FUNCTION public.sync_chatbot_inbound_recovery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW.enabled IS NOT DISTINCT FROM OLD.enabled THEN RETURN NEW; END IF;
    INSERT INTO chatbot_inbound_recovery_pages(page_id,enabled,enabled_at)
        VALUES(NEW.page_id,NEW.enabled,clock_timestamp())
    ON CONFLICT(page_id) DO UPDATE SET enabled=EXCLUDED.enabled,
        enabled_at=CASE WHEN EXCLUDED.enabled THEN EXCLUDED.enabled_at ELSE chatbot_inbound_recovery_pages.enabled_at END,
        checked_at=NULL,scan_cursor=NULL,lease_until=NULL,last_error=NULL;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.sync_chatbot_inbound_recovery() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_chatbot_inbound_recovery() TO service_role;
DROP TRIGGER IF EXISTS chatbot_recovery_enrollment ON public.chatbot_configs;
CREATE TRIGGER chatbot_recovery_enrollment AFTER INSERT OR UPDATE OF enabled ON public.chatbot_configs
    FOR EACH ROW EXECUTE FUNCTION public.sync_chatbot_inbound_recovery();
INSERT INTO app_private.schema_migrations(version,description)
VALUES('20261017_004','Enroll every enabled chatbot in recent-inbound recovery and honor disable/re-enable transitions')
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description;
NOTIFY pgrst,'reload schema';
COMMIT;
