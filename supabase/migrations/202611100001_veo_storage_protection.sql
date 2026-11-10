BEGIN;
CREATE TABLE app_private.veo_storage_state(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 metrics jsonb NOT NULL DEFAULT '{}',metrics_checked_at timestamptz,metrics_ok_at timestamptz,
 maintenance_at timestamptz,maintenance_cleared integer NOT NULL DEFAULT 0
);
INSERT INTO app_private.veo_storage_state(singleton) VALUES(true);
REVOKE ALL ON app_private.veo_storage_state FROM PUBLIC,anon,authenticated;

CREATE FUNCTION veo_storage_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE cleared integer;BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtext('veo_storage_maintenance')) THEN RETURN jsonb_build_object('skipped',true);END IF;
 WITH retired AS(
  SELECT event_key FROM veo_event_inbox WHERE status='done' AND received_at<now()-interval '7 days' AND payload<>'{}'::jsonb
  ORDER BY received_at,event_key LIMIT 500 FOR UPDATE SKIP LOCKED
 ) UPDATE veo_event_inbox i SET payload='{}'::jsonb FROM retired r WHERE i.event_key=r.event_key;
 GET DIAGNOSTICS cleared=ROW_COUNT;
 DELETE FROM cron.job_run_details WHERE end_time<now()-interval '7 days';
 UPDATE app_private.veo_storage_state SET maintenance_at=clock_timestamp(),maintenance_cleared=cleared WHERE singleton;
 RETURN jsonb_build_object('completed_event_payloads_cleared',cleared,'contacts_deleted',0,'tags_deleted',0,'financial_records_deleted',0,'dedupe_keys_deleted',0);
END $$;

-- Planning and queue delivery can fail independently of this retention job.
DO $migration$ DECLARE definition text;before_sql text:=E'WITH retired AS(SELECT event_key FROM veo_event_inbox WHERE status=''done'' AND received_at<now()-interval ''7 days'' AND payload<>''{}''::jsonb LIMIT 500)\n UPDATE veo_event_inbox i SET payload=''{}''::jsonb FROM retired r WHERE i.event_key=r.event_key;\n GET DIAGNOSTICS cleared=ROW_COUNT;';BEGIN
 definition:=pg_get_functiondef('veo_operations_maintenance()'::regprocedure);
 IF strpos(definition,before_sql)=0 THEN RAISE EXCEPTION 'Unexpected planning maintenance definition';END IF;
 definition:=replace(definition,before_sql,E'cleared:=coalesce((veo_storage_maintenance()->>''completed_event_payloads_cleared'')::integer,0);');
 EXECUTE definition;
END $migration$;

CREATE FUNCTION veo_storage_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE state app_private.veo_storage_state;bytes bigint;disk_size bigint;disk_free bigint;status text:='healthy';fresh boolean;maintenance_ok boolean;BEGIN
 SELECT * INTO state FROM app_private.veo_storage_state WHERE singleton;
 bytes:=pg_database_size(current_database());
 fresh:=state.metrics_ok_at>now()-interval '15 minutes' AND state.metrics_checked_at=state.metrics_ok_at;
 maintenance_ok:=coalesce(state.maintenance_at>now()-interval '20 minutes',false) AND EXISTS(SELECT 1 FROM cron.job j WHERE jobname='veo-storage-protection' AND coalesce((to_jsonb(j)->>'active')::boolean,true));
 disk_size:=nullif(state.metrics->>'disk_size_bytes','')::bigint;disk_free:=nullif(state.metrics->>'disk_available_bytes','')::bigint;
 -- 500 MB is the application's conservative data budget, not a disk-size claim.
 IF bytes>=400000000 OR(disk_size>0 AND(disk_free<=268435456 OR disk_free::numeric/disk_size<=0.20)) THEN status:='critical';
 ELSIF bytes>=350000000 OR(disk_size>0 AND(disk_free<=536870912 OR disk_free::numeric/disk_size<=0.30)) THEN status:='warning';
 ELSIF NOT coalesce(fresh,false) THEN status:='unknown';END IF;
 RETURN jsonb_build_object('status',status,'database_bytes',bytes,'database_budget_bytes',500000000,
  'disk_size_bytes',disk_size,'disk_available_bytes',disk_free,'metrics_fresh',coalesce(fresh,false),'metrics_checked_at',state.metrics_checked_at,'metrics_ok_at',state.metrics_ok_at,
  'wal_bytes',state.metrics->'wal_bytes','maintenance_at',state.maintenance_at,'maintenance_cleared',state.maintenance_cleared,
  'maintenance_healthy',maintenance_ok,
  'optional_work_paused',status='critical' OR NOT coalesce(fresh,false) OR NOT maintenance_ok,'checked_at',clock_timestamp());
END $$;

CREATE FUNCTION veo_record_storage_metrics(p_metrics jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE stamp timestamptz:=clock_timestamp();BEGIN
 IF p_metrics IS NULL OR jsonb_typeof(p_metrics)<>'object' OR length(p_metrics::text)>2000 THEN RAISE EXCEPTION 'Invalid storage metrics';END IF;
 IF p_metrics->>'available'='true' THEN
  IF coalesce((p_metrics->>'disk_size_bytes')::numeric,0)<=0 OR coalesce((p_metrics->>'disk_available_bytes')::numeric,-1)<0
    OR(p_metrics->>'disk_available_bytes')::numeric>(p_metrics->>'disk_size_bytes')::numeric THEN RAISE EXCEPTION 'Invalid disk metrics';END IF;
  UPDATE app_private.veo_storage_state SET metrics=jsonb_build_object('disk_size_bytes',(p_metrics->>'disk_size_bytes')::bigint,
   'disk_available_bytes',(p_metrics->>'disk_available_bytes')::bigint,'wal_bytes',(p_metrics->>'wal_bytes')::bigint),metrics_checked_at=stamp,metrics_ok_at=stamp WHERE singleton;
 ELSE UPDATE app_private.veo_storage_state SET metrics_checked_at=stamp WHERE singleton;END IF;
 RETURN veo_storage_status();
END $$;

CREATE FUNCTION veo_owner_storage_health(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=p_actor AND active AND role='owner') THEN RAISE EXCEPTION 'Owner access required' USING ERRCODE='42501';END IF;
 RETURN veo_storage_status();
END $$;

-- Keep dead tuples reusable sooner without a table rewrite or blocking VACUUM FULL.
ALTER TABLE veo_event_inbox SET(autovacuum_vacuum_scale_factor=0.05,autovacuum_vacuum_threshold=200,autovacuum_analyze_scale_factor=0.05);
ALTER TABLE contacts SET(autovacuum_vacuum_scale_factor=0.10,autovacuum_vacuum_threshold=100);
DO $$ DECLARE job record;BEGIN
 FOR job IN SELECT jobid FROM cron.job WHERE jobname='veo-storage-protection' LOOP PERFORM cron.unschedule(job.jobid);END LOOP;
 PERFORM cron.schedule('veo-storage-protection','*/5 * * * *','SELECT public.veo_storage_maintenance();');
END $$;
REVOKE ALL ON FUNCTION veo_storage_maintenance(),veo_storage_status(),veo_record_storage_metrics(jsonb),veo_owner_storage_health(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_storage_maintenance(),veo_storage_status(),veo_record_storage_metrics(jsonb),veo_owner_storage_health(uuid) TO service_role;
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611100001','Independent bounded retention, physical disk monitoring and optional-work protection') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
