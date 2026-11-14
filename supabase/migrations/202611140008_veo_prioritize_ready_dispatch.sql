BEGIN;
DO $$ DECLARE definition text;needle text;BEGIN
 definition:=pg_get_functiondef('veo_automatic_intake_tick(uuid,timestamptz)'::regprocedure);
 needle:='ORDER BY checked_at NULLS FIRST,eligible_at,id LIMIT 10 FOR UPDATE SKIP LOCKED LOOP';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Bounded dispatch implementation changed';END IF;
 -- A client whose announcement was just acknowledged must not wait behind a
 -- full rotation of old inquiries with no saved answers. Keep fairness inside
 -- both priorities and retain every Page, membership, Ready and expiry check.
 definition:=replace(definition,needle,'ORDER BY (announced_at IS NOT NULL AND eligible_at<=p_now AND (veo_intake_progress(contact_id)->>''eligible'')::boolean) DESC,checked_at NULLS FIRST,eligible_at,id LIMIT 10 FOR UPDATE SKIP LOCKED LOOP');
 EXECUTE definition;
END $$;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611140008','Prioritize announced clients with enough saved details when dispatching editor offers') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
