BEGIN;
DO $$ DECLARE definition text;needle text;BEGIN
 definition:=pg_get_functiondef('veo_automatic_intake_tick(uuid,timestamptz)'::regprocedure);
 needle:='PERFORM pg_advisory_xact_lock(hashtextextended(''veo-intake:''||p_tenant::text,0));';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Intake coordination implementation changed';END IF;
 definition:=replace(definition,needle,'IF NOT pg_try_advisory_xact_lock(hashtextextended(''veo-intake:''||p_tenant::text,0)) THEN RETURN jsonb_build_object(''skipped'',true,''reason'',''already_running'');END IF;');
 needle:='ORDER BY q.last_interaction_at,q.id LIMIT 30 LOOP';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Intake registration implementation changed';END IF;
 definition:=replace(definition,needle,'ORDER BY (veo_intake_progress(q.id)->>''eligible'')::boolean DESC,q.last_interaction_at,q.id LIMIT 5 LOOP');
 needle:='ORDER BY checked_at NULLS FIRST,eligible_at,id LIMIT 50 FOR UPDATE LOOP';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Intake fair queue implementation changed';END IF;
 definition:=replace(definition,needle,'ORDER BY checked_at NULLS FIRST,eligible_at,id LIMIT 10 FOR UPDATE SKIP LOCKED LOOP');
 EXECUTE definition;
END $$;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611140007','Bound editor dispatch batches, prioritize qualified intake and avoid overlapping transactions') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
