BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- The original one-time seed ran before recovered Pages were enabled. Start
-- coverage when tracking is actually enrolled; old message timestamps alone
-- cannot establish that a historical date was fully captured.
CREATE FUNCTION veo_calendar_enroll_message_coverage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT NEW.veo_enabled OR NEW.veo_tenant_id IS NULL THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.veo_enabled AND OLD.veo_tenant_id IS NOT DISTINCT FROM NEW.veo_tenant_id THEN RETURN NEW;END IF;
 END IF;
 INSERT INTO veo_calendar_message_coverage(page_id,capture_from)
 SELECT NEW.id,greatest(coalesce(t.launch_at,clock_timestamp()),clock_timestamp()) FROM veo_tenants t WHERE t.id=NEW.veo_tenant_id
 ON CONFLICT(page_id) DO UPDATE SET capture_from=greatest(veo_calendar_message_coverage.capture_from,EXCLUDED.capture_from);
 RETURN NEW;
END $$;
CREATE TRIGGER veo_calendar_enroll_message_coverage AFTER INSERT OR UPDATE OF veo_enabled,veo_tenant_id ON pages FOR EACH ROW EXECUTE FUNCTION veo_calendar_enroll_message_coverage();

INSERT INTO veo_calendar_message_coverage(page_id,capture_from)
 SELECT p.id,greatest(coalesce(t.launch_at,clock_timestamp()),clock_timestamp()) FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id
 WHERE p.veo_enabled ON CONFLICT(page_id) DO NOTHING;

REVOKE ALL ON FUNCTION veo_calendar_enroll_message_coverage() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_calendar_enroll_message_coverage() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
