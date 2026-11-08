BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;
CREATE TABLE veo_jev_policy(
 tenant_id uuid PRIMARY KEY REFERENCES veo_tenants(id),enabled boolean NOT NULL DEFAULT false,model_id text,
 quiet_minutes integer NOT NULL DEFAULT 5 CHECK(quiet_minutes BETWEEN 2 AND 120),activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(NOT enabled OR(model_id IS NOT NULL AND length(btrim(model_id))>0))
);
INSERT INTO veo_jev_policy(tenant_id) SELECT id FROM veo_tenants WHERE launch_at IS NOT NULL;
CREATE FUNCTION veo_initialize_intake_policies() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO veo_intake_auto_policy(tenant_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
 INSERT INTO veo_jev_policy(tenant_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER veo_initialize_intake_policies AFTER INSERT ON veo_tenants FOR EACH ROW EXECUTE FUNCTION veo_initialize_intake_policies();
CREATE TABLE veo_jev_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES veo_tenants(id),state_id uuid NOT NULL REFERENCES chatbot_contact_states(id) ON DELETE CASCADE,
 page_id uuid NOT NULL REFERENCES pages(id),contact_id uuid NOT NULL REFERENCES contacts(id),automation_epoch integer NOT NULL,
 human_activity_at timestamptz NOT NULL,last_inbound_at timestamptz,state_updated_at timestamptz NOT NULL,config_updated_at timestamptz NOT NULL,
 policy_updated_at timestamptz NOT NULL,model_id text NOT NULL,due_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','wait','resumed','follow_up','stopped','skipped','failed')),
 attempt integer NOT NULL DEFAULT 0,claimed_at timestamptz,decision jsonb,last_error text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE NULLS NOT DISTINCT(state_id,automation_epoch,human_activity_at,last_inbound_at)
);
CREATE INDEX veo_jev_due ON veo_jev_reviews(due_at) WHERE status IN('pending','wait');

CREATE FUNCTION veo_claim_jev_reviews(p_limit integer DEFAULT 2,p_now timestamptz DEFAULT clock_timestamp()) RETURNS SETOF veo_jev_reviews LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
BEGIN
 UPDATE veo_jev_reviews j SET status='skipped',claimed_at=NULL,last_error='Jev policy was disabled or changed' FROM veo_jev_policy p
 WHERE j.tenant_id=p.tenant_id AND j.status IN('pending','wait') AND(NOT p.enabled OR p.model_id IS DISTINCT FROM j.model_id OR p.updated_at IS DISTINCT FROM j.policy_updated_at);
 UPDATE veo_jev_reviews SET status=CASE WHEN attempt>=3 THEN 'failed' ELSE 'pending' END,claimed_at=NULL,last_error='Interrupted review recovered' WHERE status='processing' AND claimed_at<p_now-interval '10 minutes';
 INSERT INTO veo_jev_reviews(tenant_id,state_id,page_id,contact_id,automation_epoch,human_activity_at,last_inbound_at,state_updated_at,config_updated_at,policy_updated_at,model_id,due_at)
 SELECT p.tenant_id,s.id,s.page_id,s.contact_id,s.automation_epoch,s.last_human_activity_at,c.last_inbound_at,s.updated_at,cfg.updated_at,p.updated_at,p.model_id,
  s.last_human_activity_at+make_interval(mins=>p.quiet_minutes)
 FROM veo_jev_policy p JOIN pages pg ON pg.veo_tenant_id=p.tenant_id AND pg.veo_enabled JOIN chatbot_configs cfg ON cfg.page_id=pg.id AND cfg.enabled
 JOIN chatbot_contact_states s ON s.page_id=pg.id AND s.status='stopped' AND s.pause_kind='human_takeover' AND s.stop_reason='manual'
 JOIN contacts c ON c.id=s.contact_id AND c.page_id=pg.id AND c.chatbot_enabled IS DISTINCT FROM false
 WHERE p.enabled AND p.model_id IS NOT NULL AND s.last_human_activity_at>=p.activated_at
 AND c.pipeline_stage NOT IN('converted','order_created','not_qualified','opted_out')
 AND NOT(c.pipeline_stage='qualified' AND c.pipeline_stage_source IN('manual','messenger'))
 AND NOT EXISTS(SELECT 1 FROM veo_client_claims cc WHERE cc.contact_id=c.id AND cc.user_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM veo_orders o WHERE o.contact_id=c.id) AND NOT EXISTS(SELECT 1 FROM veo_closed_deals cd WHERE cd.contact_id=c.id AND cd.voided_at IS NULL)
 AND(NOT cfg.trial_mode_enabled OR cfg.trial_contact_id=c.id)
 ORDER BY s.last_human_activity_at LIMIT 25 ON CONFLICT DO NOTHING;
 RETURN QUERY WITH jobs AS(SELECT j.id FROM veo_jev_reviews j JOIN veo_jev_policy p ON p.tenant_id=j.tenant_id AND p.enabled AND p.model_id=j.model_id AND p.updated_at=j.policy_updated_at WHERE j.status IN('pending','wait') AND j.due_at<=p_now AND j.attempt<3 ORDER BY j.due_at,j.id LIMIT least(greatest(p_limit,1),5) FOR UPDATE OF j SKIP LOCKED)
 UPDATE veo_jev_reviews j SET status='processing',attempt=j.attempt+1,claimed_at=p_now FROM jobs WHERE j.id=jobs.id RETURNING j.*;
END $$;

CREATE FUNCTION veo_apply_jev_review(p_review uuid,p_attempt integer,p_decision jsonb,p_now timestamptz DEFAULT clock_timestamp()) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE r veo_jev_reviews;s chatbot_contact_states;c contacts;cfg chatbot_configs;p veo_jev_policy;kind text;minutes integer;BEGIN
 SELECT * INTO r FROM veo_jev_reviews WHERE id=p_review AND status='processing' AND attempt=p_attempt FOR UPDATE;
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO s FROM chatbot_contact_states WHERE id=r.state_id FOR UPDATE;
 SELECT * INTO c FROM contacts WHERE id=r.contact_id AND page_id=r.page_id FOR UPDATE;
 SELECT * INTO cfg FROM chatbot_configs WHERE page_id=r.page_id FOR SHARE;
 SELECT * INTO p FROM veo_jev_policy WHERE tenant_id=r.tenant_id FOR SHARE;
 IF s.id IS NULL OR NOT p.enabled OR p.model_id IS DISTINCT FROM r.model_id OR p.updated_at IS DISTINCT FROM r.policy_updated_at
 OR NOT cfg.enabled OR cfg.updated_at IS DISTINCT FROM r.config_updated_at OR c.chatbot_enabled=false
 OR s.status<>'stopped' OR s.pause_kind IS DISTINCT FROM 'human_takeover' OR s.stop_reason<>'manual'
 OR s.automation_epoch IS DISTINCT FROM r.automation_epoch OR s.updated_at IS DISTINCT FROM r.state_updated_at
 OR s.last_human_activity_at IS DISTINCT FROM r.human_activity_at OR c.last_inbound_at IS DISTINCT FROM r.last_inbound_at
 OR s.last_human_activity_at>p_now-make_interval(mins=>p.quiet_minutes)
 OR c.pipeline_stage IN('converted','order_created','not_qualified','opted_out') OR(c.pipeline_stage='qualified' AND c.pipeline_stage_source IN('manual','messenger'))
 OR EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=c.id AND user_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=c.id) OR EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=c.id AND voided_at IS NULL)
 OR(cfg.trial_mode_enabled AND cfg.trial_contact_id IS DISTINCT FROM c.id) THEN
  UPDATE veo_jev_reviews SET status='skipped',claimed_at=NULL,last_error='Conversation, ownership, manual permission or policy changed during review' WHERE id=r.id;RETURN false;
 END IF;
 kind:=p_decision->>'action';minutes:=greatest(5,least(120,coalesce((p_decision->>'wait_minutes')::integer,15)));
 IF kind NOT IN('wait','stop','follow_up','resume') OR p_decision->'history_verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Invalid Jev decision';END IF;
 IF kind='wait' OR coalesce((p_decision->>'confidence')::numeric,0)<0.9 THEN
  UPDATE veo_jev_reviews SET status='wait',attempt=0,claimed_at=NULL,due_at=p_now+make_interval(mins=>minutes),decision=p_decision,last_error=NULL WHERE id=r.id;RETURN true;
 END IF;
 IF kind='stop' THEN
  UPDATE chatbot_contact_states SET pause_kind='explicit_hold',stop_reason='manual',updated_at=p_now WHERE id=s.id;
  UPDATE veo_jev_reviews SET status='stopped',claimed_at=NULL,decision=p_decision,last_error=NULL WHERE id=r.id;RETURN true;
 END IF;
 IF kind='follow_up' AND(NOT cfg.follow_up_enabled OR c.last_inbound_at IS NULL OR c.last_inbound_at<p_now-interval '23 hours 59 minutes'
  OR s.window_expires_at<=p_now+make_interval(mins=>minutes)) THEN
  UPDATE veo_jev_reviews SET status='wait',attempt=0,claimed_at=NULL,due_at=p_now+interval '30 minutes',decision=p_decision,last_error='Follow-up window or Page setting does not currently permit delivery' WHERE id=r.id;RETURN true;
 END IF;
 UPDATE chatbot_contact_states SET status='active',stop_reason=NULL,stopped_at=NULL,pause_kind=NULL,automation_resumed_at=p_now,automation_epoch=s.automation_epoch+1,updated_at=p_now WHERE id=s.id;
 IF NOT EXISTS(SELECT 1 FROM chatbot_contact_states WHERE id=s.id AND status='active') THEN
  UPDATE veo_jev_reviews SET status='skipped',claimed_at=NULL,decision=p_decision,last_error='Existing intake policy kept the bot stopped' WHERE id=r.id;RETURN false;
 END IF;
 IF kind='follow_up' THEN
  INSERT INTO chatbot_follow_up_jobs(page_id,contact_id,anchor_inbound_at,schedule_type,sequence_index,due_at,message_text,purpose,automation_epoch,policy_revision)
  SELECT r.page_id,r.contact_id,c.last_inbound_at,'response',0,p_now+make_interval(mins=>minutes),'Generate a contextual Jev-reviewed follow-up at delivery','jev_continuation',ss.automation_epoch,cfg.policy_revision FROM chatbot_contact_states ss WHERE ss.id=s.id
  ON CONFLICT(contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose) DO NOTHING;
 END IF;
 UPDATE veo_jev_reviews SET status=CASE WHEN kind='resume' THEN 'resumed' ELSE 'follow_up' END,claimed_at=NULL,decision=p_decision,last_error=NULL WHERE id=r.id;
 RETURN true;
END $$;
DO $$ DECLARE constraint_name text;BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='chatbot_follow_up_jobs'::regclass AND contype='c' AND cardinality(conkey)=1 AND pg_get_constraintdef(oid) LIKE '%purpose%' LOOP
  EXECUTE format('ALTER TABLE chatbot_follow_up_jobs DROP CONSTRAINT %I',constraint_name);
 END LOOP;
 ALTER TABLE chatbot_follow_up_jobs ADD CONSTRAINT chatbot_follow_up_jobs_purpose_check CHECK(purpose IN('scheduled','nightly_continuation','first_day_adaptive','pricing_promotion','form_submission','jev_continuation'));
END $$;
DO $$ DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['veo_jev_policy','veo_jev_reviews'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',tab);EXECUTE format('GRANT ALL ON %I TO service_role',tab);
 END LOOP;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_claim_jev_reviews','veo_apply_jev_review','veo_initialize_intake_policies') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
