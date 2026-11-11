BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Schema installation can precede tenant recovery/launch. Initialize scheduling
-- lazily as well as here; an existing cursor, lease or next-run time is retained.
INSERT INTO public.veo_telegram_sync_state(tenant_id)
SELECT id FROM public.veo_tenants WHERE launch_at IS NOT NULL
ON CONFLICT(tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.veo_claim_telegram_sync() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job veo_telegram_sync_state;
BEGIN
 INSERT INTO veo_telegram_sync_state(tenant_id)
 SELECT id FROM veo_tenants WHERE launch_at IS NOT NULL
 ON CONFLICT(tenant_id) DO NOTHING;
 SELECT s.* INTO job FROM veo_telegram_sync_state s JOIN veo_tenants t ON t.id=s.tenant_id
 WHERE t.launch_at IS NOT NULL AND s.next_sync_at<=now() AND(s.lease_until IS NULL OR s.lease_until<now())
 ORDER BY s.next_sync_at,s.tenant_id LIMIT 1 FOR UPDATE OF s SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL;END IF;
 UPDATE veo_telegram_sync_state SET lease_until=now()+interval '2 minutes' WHERE tenant_id=job.tenant_id;
 RETURN to_jsonb(job);
END $$;
REVOKE ALL ON FUNCTION public.veo_claim_telegram_sync() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_claim_telegram_sync() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
