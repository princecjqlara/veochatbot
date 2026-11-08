BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit=off;
CREATE TABLE veo_source_jobs(
 contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,tenant_id uuid NOT NULL REFERENCES veo_tenants(id),page_id uuid NOT NULL REFERENCES pages(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','processing','idle','failed')),requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 due_at timestamptz NOT NULL DEFAULT clock_timestamp(),claimed_at timestamptz,claim_token uuid,attempts integer NOT NULL DEFAULT 0,last_error text,
 last_success_at timestamptz,cursor_url text,scan_started_at timestamptz
);
CREATE INDEX veo_source_due ON veo_source_jobs(due_at,contact_id) WHERE status IN('pending','failed','processing');
CREATE TABLE veo_order_drafts(
 contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,tenant_id uuid NOT NULL REFERENCES veo_tenants(id),page_id uuid NOT NULL REFERENCES pages(id),
 stage text NOT NULL,status text NOT NULL DEFAULT 'needs_invoice' CHECK(status IN('needs_invoice','needs_editor','needs_review','linked','cancelled')),
 order_id uuid REFERENCES veo_orders(id),note text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE veo_source_reviews(
 contact_id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,tenant_id uuid NOT NULL REFERENCES veo_tenants(id),page_id uuid NOT NULL REFERENCES pages(id),
 stage text NOT NULL CHECK(stage IN('qualified','converted')),stage_version timestamptz NOT NULL,source_reference text NOT NULL,reason text NOT NULL,
 reviewed_by uuid NOT NULL REFERENCES users(id),reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),order_id uuid REFERENCES veo_orders(id),order_total_minor bigint,order_currency text
);

CREATE FUNCTION veo_request_source_refresh(p_actor uuid,p_contact uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c contacts;a veo_accounts;j veo_source_jobs;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;SELECT * INTO c FROM contacts WHERE id=p_contact;
 IF a.user_id IS NULL OR c.id IS NULL OR NOT veo_can_page(p_actor,c.page_id) THEN RAISE EXCEPTION 'Client Page access denied' USING ERRCODE='42501';END IF;
 INSERT INTO veo_source_jobs(contact_id,tenant_id,page_id) VALUES(c.id,a.tenant_id,c.page_id)
 ON CONFLICT(contact_id) DO UPDATE SET requested_at=clock_timestamp(),status=CASE WHEN veo_source_jobs.status='processing' THEN 'processing' ELSE 'pending' END,
  due_at=CASE WHEN veo_source_jobs.status IN('processing','pending') THEN veo_source_jobs.due_at ELSE greatest(clock_timestamp(),coalesce(veo_source_jobs.last_success_at,'-infinity')+interval '30 seconds') END
 RETURNING * INTO j;
 RETURN jsonb_build_object('status',j.status,'requested_at',j.requested_at,'due_at',j.due_at);
END $$;
CREATE FUNCTION veo_queue_contact_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid;BEGIN
 SELECT veo_tenant_id INTO tid FROM pages WHERE id=NEW.page_id AND veo_enabled;IF tid IS NULL THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND NEW.last_inbound_at IS NOT DISTINCT FROM OLD.last_inbound_at AND NEW.pipeline_stage IS NOT DISTINCT FROM OLD.pipeline_stage THEN RETURN NEW;END IF;
 INSERT INTO veo_source_jobs(contact_id,tenant_id,page_id) VALUES(NEW.id,tid,NEW.page_id)
 ON CONFLICT(contact_id) DO UPDATE SET requested_at=clock_timestamp(),status=CASE WHEN veo_source_jobs.status='processing' THEN 'processing' ELSE 'pending' END,
 due_at=greatest(clock_timestamp(),coalesce(veo_source_jobs.last_success_at,'-infinity')+interval '1 minute');
 IF NEW.pipeline_stage IN('qualified','converted') THEN
  INSERT INTO veo_order_drafts(contact_id,tenant_id,page_id,stage) VALUES(NEW.id,tid,NEW.page_id,NEW.pipeline_stage)
  ON CONFLICT(contact_id) DO UPDATE SET stage=EXCLUDED.stage,updated_at=clock_timestamp(),status=CASE WHEN veo_order_drafts.order_id IS NULL THEN 'needs_invoice' ELSE 'linked' END;
 ELSIF NEW.pipeline_stage IN('not_qualified','opted_out') THEN
  UPDATE veo_order_drafts SET status='cancelled',updated_at=clock_timestamp() WHERE contact_id=NEW.id AND order_id IS NULL;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER veo_contact_source_changed AFTER INSERT OR UPDATE OF last_inbound_at,pipeline_stage ON contacts FOR EACH ROW EXECUTE FUNCTION veo_queue_contact_source();
CREATE FUNCTION veo_claim_source_jobs(p_limit integer DEFAULT 2) RETURNS SETOF veo_source_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN QUERY WITH due AS(
  SELECT contact_id FROM veo_source_jobs WHERE (status IN('pending','failed') AND due_at<=clock_timestamp() OR status='processing' AND claimed_at<clock_timestamp()-interval '2 minutes')
  ORDER BY due_at,contact_id LIMIT least(greatest(p_limit,1),5) FOR UPDATE SKIP LOCKED
 ) UPDATE veo_source_jobs j SET status='processing',claimed_at=clock_timestamp(),claim_token=gen_random_uuid(),attempts=attempts+1 FROM due WHERE j.contact_id=due.contact_id RETURNING j.*;
END $$;
CREATE FUNCTION veo_finish_source_job(p_contact uuid,p_claim uuid,p_scan jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j veo_source_jobs;ok boolean;BEGIN
 SELECT * INTO j FROM veo_source_jobs WHERE contact_id=p_contact AND claim_token=p_claim AND status='processing' FOR UPDATE;
 IF j.contact_id IS NULL THEN RETURN false;END IF;ok:=p_scan->>'error' IS NULL;
 UPDATE veo_source_jobs SET status=CASE WHEN NOT ok THEN 'failed' WHEN p_scan->'complete'='true'::jsonb AND requested_at<=j.claimed_at THEN 'idle' ELSE 'pending' END,
  due_at=clock_timestamp()+CASE WHEN NOT ok THEN make_interval(secs=>least(1800,30*(2^least(j.attempts,5))::integer)) ELSE interval '30 seconds' END,
  last_error=left(p_scan->>'error',500),last_success_at=CASE WHEN ok AND p_scan->'complete'='true'::jsonb THEN coalesce(j.scan_started_at,j.claimed_at) ELSE last_success_at END,
  cursor_url=CASE WHEN ok THEN p_scan->>'next_cursor' ELSE j.cursor_url END,
  scan_started_at=CASE WHEN ok AND p_scan->'complete'='true'::jsonb THEN NULL ELSE coalesce(j.scan_started_at,j.claimed_at) END,
  claim_token=NULL,claimed_at=NULL,attempts=CASE WHEN ok THEN 0 ELSE attempts END WHERE contact_id=p_contact;
 RETURN true;
END $$;

CREATE FUNCTION veo_receipt_stage_evidence(p_contact uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c contacts;e messenger_lead_stage_events;r veo_source_reviews;j veo_source_jobs;BEGIN
 SELECT * INTO c FROM contacts WHERE id=p_contact;SELECT * INTO j FROM veo_source_jobs WHERE contact_id=p_contact;
 SELECT * INTO e FROM messenger_lead_stage_events WHERE contact_id=p_contact AND page_id=c.page_id
 AND NOT(stage='order_created' AND EXISTS(SELECT 1 FROM veo_business_orders b WHERE b.message_id=messenger_lead_stage_events.message_id AND b.contact_id=p_contact))
 ORDER BY occurred_at DESC,id DESC LIMIT 1;
 SELECT * INTO r FROM veo_source_reviews WHERE contact_id=p_contact AND stage=c.pipeline_stage AND stage_version=c.pipeline_stage_updated_at AND veo_can_page(reviewed_by,c.page_id)
 AND NOT EXISTS(SELECT 1 FROM messenger_lead_stage_events WHERE contact_id=p_contact AND occurred_at>reviewed_at);
 IF r.contact_id IS NOT NULL THEN RETURN jsonb_build_object('complete',true,'source','supervisor_review','stage',r.stage,'started_at',r.reviewed_at,'checked_at',r.reviewed_at,'stage_occurred_at',r.reviewed_at,
 'reference',r.source_reference,'coverage','Supervisor-reviewed source evidence; not an automatic Facebook fetch','error',NULL,'refresh_status',j.status);END IF;
 IF e.id IS NOT NULL AND e.stage=c.pipeline_stage AND c.pipeline_stage_source='messenger' AND e.message_id=c.messenger_stage_message_id THEN
  RETURN jsonb_build_object('complete',true,'source','messenger_event','stage',e.stage,'stage_message_id',e.message_id,'stage_occurred_at',e.occurred_at,
   'started_at',coalesce(j.last_success_at,e.occurred_at),'checked_at',coalesce(j.last_success_at,e.occurred_at),'coverage','Saved Facebook stage event; checked against the current client stage','error',NULL,'refresh_status',j.status,'refresh_error',j.last_error);
 END IF;
 RETURN jsonb_build_object('complete',false,'source','unavailable','stage',NULL,'started_at',j.last_success_at,'checked_at',j.last_success_at,'coverage','Facebook has not exposed an explicit current stage. Refresh or ask a supervisor to review source evidence.','error',j.last_error,'refresh_status',j.status);
END $$;

CREATE FUNCTION veo_review_source_evidence(p_actor uuid,p_contact uuid,p_stage text,p_reference text,p_reason text,p_order uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;c contacts;o veo_orders;r veo_source_reviews;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 SELECT * INTO c FROM contacts WHERE id=p_contact FOR UPDATE;
 IF a.user_id IS NULL OR a.role NOT IN('owner','team_leader','manager') OR NOT veo_can_page(p_actor,c.page_id) THEN RAISE EXCEPTION 'Supervisor Page access required' USING ERRCODE='42501';END IF;
 IF p_stage NOT IN('qualified','converted') OR p_stage IS NULL OR coalesce(length(trim(p_reference)),0) NOT BETWEEN 5 AND 500 OR coalesce(length(trim(p_reason)),0) NOT BETWEEN 10 AND 1000 THEN RAISE EXCEPTION 'Choose a stage and provide the actual source reference and review explanation';END IF;
 IF p_order IS NOT NULL THEN
  SELECT * INTO o FROM veo_orders WHERE id=p_order AND contact_id=c.id AND page_id=c.page_id AND tenant_id=a.tenant_id AND seller_id IN(SELECT veo_branch(p_actor));
  IF o.id IS NULL THEN RAISE EXCEPTION 'Order outside your branch or client' USING ERRCODE='42501';END IF;
 END IF;
 -- Update only the stage. Calling the broader contact editor with empty fields
 -- would overwrite saved intake answers during a supervisor source review.
 UPDATE contacts SET pipeline_stage=p_stage,pipeline_stage_source='manual',pipeline_stage_updated_at=clock_timestamp(),messenger_stage_label=NULL,messenger_stage_message_id=NULL WHERE id=c.id;
 SELECT * INTO c FROM contacts WHERE id=p_contact;
 INSERT INTO veo_source_reviews(contact_id,tenant_id,page_id,stage,stage_version,source_reference,reason,reviewed_by,order_id,order_total_minor,order_currency)
 VALUES(c.id,a.tenant_id,c.page_id,c.pipeline_stage,c.pipeline_stage_updated_at,trim(p_reference),trim(p_reason),p_actor,o.id,o.total_minor,o.currency)
 ON CONFLICT(contact_id) DO UPDATE SET stage=EXCLUDED.stage,stage_version=EXCLUDED.stage_version,source_reference=EXCLUDED.source_reference,reason=EXCLUDED.reason,reviewed_by=p_actor,reviewed_at=clock_timestamp(),order_id=o.id,order_total_minor=o.total_minor,order_currency=o.currency;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(a.tenant_id,p_actor,'source_evidence_review',c.id,jsonb_build_object('stage',c.pipeline_stage,'reference',p_reference,'order_id',o.id),p_reason);
 RETURN veo_receipt_stage_evidence(c.id);
END $$;

ALTER FUNCTION veo_receipt_requirements(uuid,uuid,uuid,text,uuid,boolean) RENAME TO veo_receipt_requirements_before_saved_sources;
CREATE FUNCTION veo_receipt_requirements(p_actor uuid,p_contact uuid,p_seller uuid,p_kind text,p_order uuid DEFAULT NULL,p_fresh boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE result jsonb;proof jsonb;blocks jsonb;o veo_order_facts;r veo_source_reviews;BEGIN
 -- Existing checks still enforce current branch, seller, payment and Telegram access.
 result:=veo_receipt_requirements_before_saved_sources(p_actor,p_contact,p_seller,p_kind,p_order,false);
 proof:=veo_receipt_stage_evidence(p_contact);
 SELECT coalesce(jsonb_agg(value),'[]') INTO blocks FROM jsonb_array_elements(result->'blockers') WHERE value#>>'{}' NOT IN('facebook_check_required','facebook_stage_unavailable','facebook_eligible_lead_required','facebook_stage_conflict','facebook_matching_order_required');
 IF NOT(proof->>'complete')::boolean THEN blocks:=blocks||'"facebook_stage_unavailable"'::jsonb;
 ELSIF proof->>'stage' NOT IN('qualified','converted') THEN blocks:=blocks||'"facebook_eligible_lead_required"'::jsonb;END IF;
 IF p_kind='done' AND p_order IS NOT NULL THEN
  SELECT * INTO o FROM veo_order_facts WHERE id=p_order;
  SELECT * INTO r FROM veo_source_reviews WHERE contact_id=p_contact AND order_id=o.id AND order_total_minor=o.total_minor AND order_currency=o.currency AND proof->>'source'='supervisor_review';
  IF r.contact_id IS NULL AND NOT EXISTS(SELECT 1 FROM veo_business_orders WHERE order_id=o.id AND contact_id=p_contact AND NOT price_conflict AND total_minor=o.total_minor AND currency=o.currency) THEN blocks:=blocks||'"facebook_matching_order_required"'::jsonb;END IF;
 END IF;
 RETURN result||jsonb_build_object('allowed',jsonb_array_length(blocks)=0,'blockers',blocks,'facebook',proof);
END $$;

CREATE FUNCTION veo_reconcile_contact_order(p_actor uuid,p_contact uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c contacts;a veo_accounts;b veo_business_orders;editor uuid;closed uuid;n integer;result jsonb;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;SELECT * INTO c FROM contacts WHERE id=p_contact FOR UPDATE;
 IF a.user_id IS NULL OR NOT veo_can_page(p_actor,c.page_id) THEN RAISE EXCEPTION 'Client Page access denied' USING ERRCODE='42501';END IF;
 IF c.pipeline_stage NOT IN('qualified','converted') THEN RETURN NULL;END IF;
 INSERT INTO veo_order_drafts(contact_id,tenant_id,page_id,stage) VALUES(c.id,a.tenant_id,c.page_id,c.pipeline_stage) ON CONFLICT DO NOTHING;
 SELECT user_id INTO editor FROM veo_client_claims WHERE contact_id=c.id;
 SELECT * INTO b FROM veo_business_orders WHERE contact_id=c.id AND order_id IS NULL AND NOT price_conflict ORDER BY occurred_at DESC LIMIT 1;
 IF b.id IS NULL THEN RETURN jsonb_build_object('status','needs_invoice');END IF;
 IF editor IS NULL OR NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=editor AND active AND role IN('member','manager') AND veo_can_page(editor,c.page_id)) THEN
  UPDATE veo_order_drafts SET status='needs_editor',note='Choose the responsible editor before importing the invoice',updated_at=clock_timestamp() WHERE contact_id=c.id;RETURN jsonb_build_object('status','needs_editor');END IF;
 SELECT count(*) INTO n FROM veo_closed_deals WHERE contact_id=c.id AND seller_id=editor AND currency=b.currency AND order_id IS NULL AND voided_at IS NULL;
 IF n>1 THEN UPDATE veo_order_drafts SET status='needs_review',note='Several earlier Closed Deals could match this invoice',updated_at=clock_timestamp() WHERE contact_id=c.id;RETURN jsonb_build_object('status','needs_review');END IF;
 SELECT id INTO closed FROM veo_closed_deals WHERE contact_id=c.id AND seller_id=editor AND currency=b.currency AND order_id IS NULL AND voided_at IS NULL LIMIT 1;
 result:=veo_action(p_actor,'import_business_order',jsonb_build_object('business_order_id',b.id,'seller_id',editor,'deal_mode',CASE WHEN closed IS NULL THEN 'new' ELSE 'existing' END,'closed_deal_id',closed));
 UPDATE veo_order_drafts SET status='linked',order_id=(result->>'id')::uuid,note=NULL,updated_at=clock_timestamp() WHERE contact_id=c.id;
 RETURN jsonb_build_object('status','linked','order_id',result->>'id');
END $$;

ALTER FUNCTION veo_handoff(uuid) RENAME TO veo_handoff_before_source_details;
CREATE FUNCTION veo_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;r veo_receipts;b veo_business_orders;pg pages;c contacts;proof jsonb;BEGIN
 result:=veo_handoff_before_source_details(p_submission);IF result IS NULL THEN RETURN NULL;END IF;
 SELECT r0.* INTO r FROM veo_submissions s JOIN veo_receipts r0 ON r0.object_path=s.object_path WHERE s.id=p_submission AND r0.deleted_at IS NULL LIMIT 1;
 IF r.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO pg FROM pages WHERE id=r.page_id;SELECT * INTO c FROM contacts WHERE id=r.contact_id;
 SELECT * INTO b FROM veo_business_orders WHERE order_id=r.order_id AND contact_id=r.contact_id;
 proof:=veo_receipt_stage_evidence(r.contact_id);
 RETURN result||jsonb_build_object('receipt_id',r.id,'receipt_kind',r.receipt_kind,'receipt_created_at',r.created_at,'receipt_notes',r.notes,
  'page_name',pg.name,'lead_stage',c.pipeline_stage,'source_evidence',proof,'invoice_id',b.invoice_id,'invoice_message_id',b.message_id,
  'closed_amount_minor',r.closed_amount_minor,'closed_currency',r.closed_currency,'closed_occurred_at',r.closed_occurred_at);
END $$;

CREATE FUNCTION veo_source_page(p_actor uuid,p_contact uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c contacts;BEGIN
 SELECT * INTO c FROM contacts WHERE id=p_contact;
 IF c.id IS NULL OR NOT veo_can_page(p_actor,c.page_id) THEN RAISE EXCEPTION 'Client Page access denied' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('contact',jsonb_build_object('id',c.id,'name',c.name,'page_id',c.page_id,'page_name',(SELECT name FROM pages WHERE id=c.page_id),'pipeline_stage',c.pipeline_stage,'owner_id',(SELECT user_id FROM veo_client_claims WHERE contact_id=c.id),'owner_name',(SELECT u.name FROM veo_client_claims cc JOIN users u ON u.id=cc.user_id WHERE cc.contact_id=c.id)),
 'fields',coalesce((SELECT fields FROM veo_contact_details WHERE contact_id=c.id),'{}'::jsonb),'intake',veo_intake_progress(c.id),'evidence',veo_receipt_stage_evidence(c.id),'draft',(SELECT to_jsonb(d)-'tenant_id' FROM veo_order_drafts d WHERE contact_id=c.id),
 'sync',(SELECT to_jsonb(j)-'cursor_url'-'claim_token'-'tenant_id' FROM veo_source_jobs j WHERE contact_id=c.id),
 'stage_history',coalesce((SELECT jsonb_agg(to_jsonb(e)) FROM(SELECT stage,label,occurred_at,applied FROM messenger_lead_stage_events WHERE contact_id=c.id ORDER BY occurred_at DESC,id DESC LIMIT 15)e),'[]'),
 'can_review',(SELECT role IN('owner','team_leader','manager') FROM veo_accounts WHERE user_id=p_actor AND active));
END $$;
CREATE FUNCTION veo_submission_requirements(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_receipts;result jsonb;conflict boolean:=false;BEGIN
 SELECT r0.* INTO r FROM veo_submissions s JOIN veo_receipts r0 ON r0.object_path=s.object_path WHERE s.id=p_submission LIMIT 1;
 IF r.id IS NULL THEN RETURN jsonb_build_object('allowed',false,'blockers',jsonb_build_array('receipt_not_available'),'source_conflict',false);END IF;
 result:=veo_receipt_requirements(r.submitted_by,r.contact_id,r.seller_id,r.receipt_kind,r.order_id,true);
 IF r.order_id IS NOT NULL THEN SELECT coalesce(bool_or(price_conflict),false) INTO conflict FROM veo_business_orders WHERE order_id=r.order_id AND contact_id=r.contact_id;END IF;
 RETURN result||jsonb_build_object('source_conflict',conflict,'contact_id',r.contact_id,'actor_id',r.submitted_by);
END $$;
ALTER FUNCTION veo_workflow_warnings(uuid,uuid) RENAME TO veo_workflow_warnings_before_missed_offers;
CREATE FUNCTION veo_workflow_warnings(p_actor uuid,p_worker uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN
 result:=veo_workflow_warnings_before_missed_offers(p_actor,p_worker);
 RETURN result||jsonb_build_object('workers',coalesce((SELECT jsonb_agg(w.value||jsonb_build_object('warnings',coalesce(w.value->'warnings','[]'::jsonb)||coalesce((
  SELECT jsonb_agg(jsonb_build_object('key','missed-offer:'||o.id,'kind','missed_client_offer','severity','attention','title','A delivered client offer was not accepted before its 15-minute deadline',
   'offer_id',o.id,'contact_id',d.contact_id,'page_id',d.page_id,'expired_at',o.expires_at,'created_at',a.created_at,'automatic',true)
   ORDER BY o.expires_at DESC)
  FROM veo_intake_dispatch_attempts a JOIN veo_client_offers o ON o.id=a.offer_id JOIN veo_intake_dispatch d ON d.id=a.dispatch_id
  WHERE a.user_id=(w.value->>'id')::uuid AND a.delivered_at IS NOT NULL AND o.status='expired' AND o.expires_at>now()-interval '30 days' AND veo_can_page(p_actor,d.page_id)
 ),'[]'::jsonb)) ORDER BY w.value->>'name') FROM jsonb_array_elements(result->'workers') w),'[]'::jsonb));
END $$;
DO $$ DECLARE tab text;fn record;BEGIN
 FOREACH tab IN ARRAY ARRAY['veo_source_jobs','veo_order_drafts','veo_source_reviews'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',tab);EXECUTE format('GRANT ALL ON %I TO service_role',tab);
 END LOOP;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_request_source_refresh','veo_queue_contact_source','veo_claim_source_jobs','veo_finish_source_job','veo_receipt_stage_evidence','veo_review_source_evidence','veo_receipt_requirements','veo_reconcile_contact_order','veo_source_page','veo_submission_requirements','veo_handoff','veo_workflow_warnings','veo_workflow_warnings_before_missed_offers') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
