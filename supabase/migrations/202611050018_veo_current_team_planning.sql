BEGIN;
ALTER TABLE veo_team_daily_capacity ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
DROP TRIGGER veo_team_capacity_readonly ON veo_team_daily_capacity;
CREATE FUNCTION public.veo_freeze_completed_team_capacity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
 BEGIN
 IF TG_OP='DELETE' OR OLD.work_date<veo_today() OR NEW.team_id<>OLD.team_id OR NEW.work_date<>OLD.work_date THEN
 RAISE EXCEPTION 'Completed team capacity records are read-only'; END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER veo_team_capacity_readonly BEFORE UPDATE OR DELETE ON veo_team_daily_capacity FOR EACH ROW EXECUTE FUNCTION veo_freeze_completed_team_capacity();

DO $migration$
 DECLARE definition text; previous text;
 BEGIN
 definition:=pg_get_functiondef('public.veo_team_capacity(uuid,date)'::regprocedure);
 previous:=$old$IF NOT FOUND THEN
 INSERT INTO veo_team_daily_capacity$old$;
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Current team planning source mismatch'; END IF;
 definition:=replace(definition,previous,$new$IF NOT FOUND OR p_day=veo_today() THEN
 INSERT INTO veo_team_daily_capacity$new$);
 previous:=$old$ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM veo_team_daily_capacity$old$;
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Team snapshot refresh source mismatch'; END IF;
 definition:=replace(definition,previous,$new$ON CONFLICT(team_id,work_date) DO UPDATE SET workers=EXCLUDED.workers,capacity=EXCLUDED.capacity,
 participating=EXCLUDED.participating,inactive=EXCLUDED.inactive,unknown=EXCLUDED.unknown,quota=EXCLUDED.quota,updated_at=clock_timestamp()
 WHERE veo_team_daily_capacity.work_date=veo_today() AND
 ROW(veo_team_daily_capacity.workers,veo_team_daily_capacity.capacity,veo_team_daily_capacity.participating,veo_team_daily_capacity.inactive,veo_team_daily_capacity.unknown,veo_team_daily_capacity.quota)
 IS DISTINCT FROM ROW(EXCLUDED.workers,EXCLUDED.capacity,EXCLUDED.participating,EXCLUDED.inactive,EXCLUDED.unknown,EXCLUDED.quota);
 SELECT * INTO frozen FROM veo_team_daily_capacity$new$);
 previous:=$old$WHERE a.tenant_id=actor.tenant_id AND a.active AND a.role IN('manager','member') AND(a.user_id=tm.manager_id OR a.parent_id=tm.manager_id)
 ON CONFLICT$old$;
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Historical roster source mismatch'; END IF;
 definition:=replace(definition,previous,$new$WHERE a.tenant_id=actor.tenant_id AND a.active AND a.role IN('manager','member') AND(a.user_id=tm.manager_id OR a.parent_id=tm.manager_id)
 AND(p_day=veo_today() OR EXISTS(SELECT 1 FROM veo_daily_targets enrolled WHERE enrolled.user_id=a.user_id AND(enrolled.created_at AT TIME ZONE 'Asia/Manila')::date<=p_day))
 ON CONFLICT$new$);
 EXECUTE definition;
 END $migration$;
REVOKE ALL ON FUNCTION veo_freeze_completed_team_capacity() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_freeze_completed_team_capacity() TO service_role;
COMMIT;
