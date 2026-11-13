BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Keep the existing atomic approval and Telegram outbox path, while letting
-- supervisors explicitly request independent review for a new submission.
-- A retry must never promote an existing pending submission to approved.
DO $$ DECLARE definition text;needle text:=$old$IF a.role IN('owner','team_leader','manager') AND veo_supervisor_submissions_enabled(a.tenant_id) THEN$old$;BEGIN
 definition:=pg_get_functiondef('veo_submit_deal_review(uuid,jsonb,uuid[])'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Supervisor submission implementation changed';END IF;
 EXECUTE replace(definition,needle,$new$IF NOT duplicate AND coalesce(p_data->'auto_approve','true'::jsonb)='true'::jsonb AND a.role IN('owner','team_leader','manager') AND veo_supervisor_submissions_enabled(a.tenant_id) THEN$new$);
END $$;

NOTIFY pgrst,'reload schema';
COMMIT;
