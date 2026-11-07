BEGIN;
CREATE TABLE veo_facebook_checks(
 contact_id uuid PRIMARY KEY REFERENCES contacts(id),tenant_id uuid NOT NULL REFERENCES veo_tenants(id),page_id uuid NOT NULL REFERENCES pages(id),
 checked_by uuid NOT NULL REFERENCES users(id),started_at timestamptz NOT NULL,checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 stage text,stage_message_id text,stage_occurred_at timestamptz,complete boolean NOT NULL,pages_checked integer NOT NULL CHECK(pages_checked BETWEEN 0 AND 5),
 invoice_ids text[] NOT NULL DEFAULT '{}',coverage text NOT NULL,error text
);
ALTER TABLE veo_facebook_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_facebook_checks FROM PUBLIC,anon,authenticated;GRANT ALL ON veo_facebook_checks TO service_role;
ALTER TABLE veo_receipts ADD COLUMN facebook_evidence jsonb;
ALTER TABLE veo_business_orders ALTER COLUMN observed_at SET DEFAULT clock_timestamp();

CREATE FUNCTION veo_facebook_check_context(p_actor uuid,p_contact uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;c contacts;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;SELECT * INTO c FROM contacts WHERE id=p_contact;
 IF a.user_id IS NULL OR c.id IS NULL OR NOT veo_can_page(p_actor,c.page_id) THEN RAISE EXCEPTION 'Client Page access denied' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('page_id',c.page_id,'psid',c.psid,'launch_at',(SELECT launch_at FROM veo_tenants WHERE id=a.tenant_id));
END $$;

CREATE FUNCTION veo_record_facebook_check(p_actor uuid,p_contact uuid,p_started_at timestamptz,p_scan jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;c contacts;f veo_facebook_checks;stage_at timestamptz;BEGIN
 PERFORM veo_facebook_check_context(p_actor,p_contact);
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;SELECT * INTO c FROM contacts WHERE id=p_contact;
 IF p_started_at<now()-interval '2 minutes' OR p_started_at>clock_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'Facebook check expired. Check again';END IF;
 -- Serialize observations, including errors, so an older request cannot revive a
 -- newer failed check or refresh invoices belonging to an older snapshot.
 PERFORM 1 FROM contacts WHERE id=c.id FOR UPDATE;
 SELECT * INTO f FROM veo_facebook_checks WHERE contact_id=c.id;
 IF f.started_at>p_started_at THEN RETURN jsonb_build_object('complete',f.complete,'error',f.error,'checked_at',f.checked_at);END IF;
 IF p_scan->>'stage' IS NOT NULL AND p_scan->'stage'<> 'null'::jsonb THEN
  stage_at:=(p_scan->'stage'->>'occurred_at')::timestamptz;
  IF stage_at IS NULL OR stage_at<(SELECT launch_at FROM veo_tenants WHERE id=a.tenant_id) OR stage_at>clock_timestamp() OR coalesce(p_scan->'stage'->>'message_id','')='' THEN RAISE EXCEPTION 'Invalid Facebook stage evidence';END IF;
 END IF;
 PERFORM veo_observe_business_orders(p_actor,p_contact,coalesce(p_scan->'orders','[]'));
 INSERT INTO veo_facebook_checks(contact_id,tenant_id,page_id,checked_by,started_at,stage,stage_message_id,stage_occurred_at,complete,pages_checked,invoice_ids,coverage,error)
 VALUES(c.id,a.tenant_id,c.page_id,p_actor,p_started_at,p_scan->'stage'->>'stage',p_scan->'stage'->>'message_id',stage_at,coalesce((p_scan->>'complete')::boolean,false),coalesce((p_scan->>'pages_checked')::integer,0),
 ARRAY(SELECT value->>'invoice_id' FROM jsonb_array_elements(coalesce(p_scan->'orders','[]'))),left(coalesce(p_scan->>'coverage','Facebook evidence unavailable'),1000),left(p_scan->>'error',500))
 ON CONFLICT(contact_id) DO UPDATE SET checked_by=EXCLUDED.checked_by,started_at=EXCLUDED.started_at,checked_at=clock_timestamp(),stage=EXCLUDED.stage,stage_message_id=EXCLUDED.stage_message_id,stage_occurred_at=EXCLUDED.stage_occurred_at,
 complete=EXCLUDED.complete,pages_checked=EXCLUDED.pages_checked,invoice_ids=EXCLUDED.invoice_ids,coverage=EXCLUDED.coverage,error=EXCLUDED.error;
 -- Import this explicit administrative event only. The existing chronological
 -- and manual-correction guards remain authoritative; no conversation backfill.
 IF stage_at IS NOT NULL AND p_scan->'stage'->>'stage' IN('qualified','converted','not_qualified','new','engaged','collecting_details','order_created','opted_out') THEN
  PERFORM apply_messenger_lead_stage(c.page_id,c.id,p_scan->'stage'->>'message_id',initcap(replace(p_scan->'stage'->>'stage','_',' ')),p_scan->'stage'->>'stage',stage_at);
 END IF;
 RETURN jsonb_build_object('complete',coalesce((p_scan->>'complete')::boolean,false),'error',p_scan->>'error','checked_at',clock_timestamp());
END $$;

CREATE FUNCTION veo_receipt_requirements(p_actor uuid,p_contact uuid,p_seller uuid,p_kind text,p_order uuid DEFAULT NULL,p_fresh boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE a veo_accounts;w veo_accounts;c contacts;o veo_order_facts;b veo_business_orders;f veo_facebook_checks;team uuid;blocks jsonb:='[]';BEGIN
 PERFORM veo_facebook_check_context(p_actor,p_contact);
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;SELECT * INTO c FROM contacts WHERE id=p_contact;
 SELECT * INTO w FROM veo_accounts WHERE user_id=p_seller AND active AND tenant_id=a.tenant_id AND role IN('member','manager');
 IF w.user_id IS NULL OR p_seller NOT IN(SELECT veo_descendants(p_actor)) OR NOT veo_can_page(p_seller,c.page_id) THEN RAISE EXCEPTION 'Seller outside your branch or Page' USING ERRCODE='42501';END IF;
 IF p_kind NOT IN('closed','done') OR p_kind IS NULL THEN RAISE EXCEPTION 'Choose Closed Deal or Done Deal';END IF;
 SELECT * INTO f FROM veo_facebook_checks WHERE contact_id=c.id AND tenant_id=a.tenant_id AND page_id=c.page_id;
 IF f.contact_id IS NULL OR f.error IS NOT NULL OR NOT f.complete OR(p_fresh AND f.started_at<now()-interval '2 minutes') THEN blocks:=blocks||'"facebook_check_required"'::jsonb;
 ELSIF f.stage IS NULL OR f.stage_message_id IS NULL THEN blocks:=blocks||'"facebook_stage_unavailable"'::jsonb;
 ELSIF f.stage NOT IN('qualified','converted') THEN blocks:=blocks||'"facebook_eligible_lead_required"'::jsonb;END IF;
 IF c.pipeline_stage IS NULL OR c.pipeline_stage NOT IN('qualified','converted') THEN blocks:=blocks||'"eligible_lead_required"'::jsonb;END IF;
 IF p_order IS NOT NULL THEN
  SELECT * INTO o FROM veo_order_facts WHERE id=p_order;
  IF o.id IS NULL OR o.tenant_id<>a.tenant_id OR o.contact_id<>c.id OR o.page_id<>c.page_id OR o.seller_id<>p_seller THEN RAISE EXCEPTION 'Choose this seller''s order for this client' USING ERRCODE='42501';END IF;
 END IF;
 IF p_kind='done' THEN
  IF o.id IS NULL THEN blocks:=blocks||'"create_and_link_order"'::jsonb;
  ELSE
   SELECT * INTO b FROM veo_business_orders WHERE order_id=o.id AND contact_id=c.id AND tenant_id=a.tenant_id AND page_id=c.page_id;
   IF b.id IS NULL OR b.price_conflict OR b.total_minor<>o.total_minor OR b.currency<>o.currency OR NOT coalesce(b.invoice_id=ANY(f.invoice_ids),false) OR b.observed_at<f.started_at THEN blocks:=blocks||'"facebook_matching_order_required"'::jsonb;END IF;
   IF o.done_at IS NULL OR abs(o.paid_minor-o.total_minor)>o.settlement_tolerance_minor THEN blocks:=blocks||'"verify_full_payment"'::jsonb;END IF;
  END IF;
 END IF;
 SELECT id INTO team FROM veo_teams WHERE manager_id=CASE WHEN w.role='manager' THEN w.user_id ELSE w.parent_id END AND tenant_id=a.tenant_id;
 IF NOT EXISTS(SELECT 1 FROM veo_teams WHERE id=team AND telegram_chat_id IS NOT NULL) OR NOT EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=w.user_id) THEN blocks:=blocks||'"telegram_mapping_required"'::jsonb;END IF;
 RETURN jsonb_build_object('allowed',jsonb_array_length(blocks)=0,'blockers',blocks,'lead_stage',c.pipeline_stage,'facebook',jsonb_build_object('checked_at',f.checked_at,'started_at',f.started_at,'stage',f.stage,'stage_occurred_at',f.stage_occurred_at,'complete',f.complete,'coverage',f.coverage,'error',f.error),
 'total_minor',o.total_minor,'paid_minor',o.paid_minor,'currency',o.currency,'settlement_tolerance_minor',o.settlement_tolerance_minor);
END $$;

ALTER FUNCTION veo_receipt_facts(uuid) RENAME TO veo_receipt_facts_before_facebook;
CREATE FUNCTION veo_receipt_facts(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;r veo_receipts;requirements jsonb;BEGIN
 result:=veo_receipt_facts_before_facebook(p_id);
 IF result IS NULL OR result->>'deleted_at' IS NOT NULL THEN RETURN result;END IF;
 SELECT * INTO r FROM veo_receipts WHERE id=p_id;
 -- Facts remain readable after revocation; existing access and handoff functions
 -- enforce authorization. Never call the authorized preflight for revoked staff.
 IF veo_can_page(r.submitted_by,r.page_id) AND veo_can_page(r.seller_id,r.page_id) AND r.seller_id IN(SELECT veo_descendants(r.submitted_by)) THEN
  requirements:=veo_receipt_requirements(r.submitted_by,r.contact_id,r.seller_id,r.receipt_kind,r.order_id,false);
  result:=result||jsonb_build_object('facebook',requirements->'facebook','holds',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements((result->'holds')||(requirements->'blockers'))));
 END IF;
 RETURN result;
END $$;

ALTER FUNCTION veo_receipt_save(uuid,jsonb) RENAME TO veo_receipt_save_before_facebook;
CREATE FUNCTION veo_receipt_save(p_actor uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE requirements jsonb;result jsonb;existing uuid;BEGIN
 SELECT id INTO existing FROM veo_receipts WHERE submitted_by=p_actor AND request_id=(p_data->>'request_id')::uuid AND contact_id=(p_data->>'contact_id')::uuid AND seller_id=(p_data->>'seller_id')::uuid AND receipt_kind=p_data->>'receipt_kind';
 IF existing IS NOT NULL THEN RETURN veo_receipt_access(p_actor,existing)||jsonb_build_object('duplicate',true);END IF;
 -- Lock the check and client while saving. The database rejects bypasses and
 -- rolls back the CD, receipt and queue together if a prerequisite changed.
 PERFORM 1 FROM contacts WHERE id=(p_data->>'contact_id')::uuid FOR UPDATE;
 PERFORM 1 FROM veo_orders WHERE id=nullif(p_data->>'order_id','')::uuid FOR UPDATE;
 requirements:=veo_receipt_requirements(p_actor,(p_data->>'contact_id')::uuid,(p_data->>'seller_id')::uuid,p_data->>'receipt_kind',nullif(p_data->>'order_id','')::uuid,true);
 IF NOT(requirements->>'allowed')::boolean THEN RAISE EXCEPTION 'Receipt not submitted. Complete the requirements and check Facebook again' USING ERRCODE='23514',DETAIL=(requirements->'blockers')::text;END IF;
 IF p_data->>'receipt_kind'='closed' AND(coalesce((p_data->>'closed_amount_minor')::bigint,0)<=0 OR nullif(p_data->>'closed_occurred_at','') IS NULL) THEN RAISE EXCEPTION 'Enter the down payment and payment time';END IF;
 result:=veo_receipt_save_before_facebook(p_actor,p_data);
 IF jsonb_array_length(result->'holds')>0 THEN RAISE EXCEPTION 'Receipt requirements changed. Check again before submitting' USING ERRCODE='23514';END IF;
 UPDATE veo_receipts SET facebook_evidence=requirements->'facebook' WHERE id=(result->>'id')::uuid;
 RETURN veo_receipt_facts((result->>'id')::uuid)||jsonb_build_object('duplicate',coalesce((result->>'duplicate')::boolean,false));
END $$;

ALTER FUNCTION veo_receipt_recheck(uuid,uuid,uuid) RENAME TO veo_receipt_recheck_before_facebook;
CREATE FUNCTION veo_receipt_recheck(p_actor uuid,p_id uuid,p_order uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_receipts;requirements jsonb;BEGIN
 PERFORM veo_receipt_access(p_actor,p_id);SELECT * INTO r FROM veo_receipts WHERE id=p_id FOR UPDATE;
 IF r.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Deleted receipts cannot be rechecked';END IF;
 PERFORM 1 FROM veo_orders WHERE id=coalesce(p_order,r.order_id) FOR UPDATE;
 requirements:=veo_receipt_requirements(p_actor,r.contact_id,r.seller_id,r.receipt_kind,coalesce(p_order,r.order_id),true);
 IF NOT(requirements->>'allowed')::boolean THEN RAISE EXCEPTION 'Receipt is ineligible. Complete the requirements and check Facebook again' USING ERRCODE='23514',DETAIL=(requirements->'blockers')::text;END IF;
 RETURN veo_receipt_recheck_before_facebook(p_actor,p_id,p_order);
END $$;

CREATE FUNCTION veo_submission_facebook_context(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s veo_submissions;r veo_receipts;BEGIN
 SELECT * INTO s FROM veo_submissions WHERE id=p_submission AND status IN('queued','processing','delivered') AND deleted_at IS NULL AND expires_at>now();
 IF s.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO r FROM veo_receipts WHERE object_path=s.object_path AND deleted_at IS NULL ORDER BY created_at LIMIT 1;
 IF r.id IS NULL OR NOT veo_can_page(r.submitted_by,r.page_id) OR NOT veo_can_page(r.seller_id,r.page_id) OR r.seller_id NOT IN(SELECT veo_descendants(r.submitted_by)) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('actor_id',r.submitted_by,'contact_id',r.contact_id);
END $$;
ALTER FUNCTION veo_handoff(uuid) RENAME TO veo_handoff_before_facebook;
CREATE FUNCTION veo_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_receipts;requirements jsonb;BEGIN
 IF veo_submission_facebook_context(p_submission) IS NULL THEN RETURN NULL;END IF;
 SELECT r0.* INTO r FROM veo_receipts r0 JOIN veo_submissions s ON s.object_path=r0.object_path WHERE s.id=p_submission AND r0.deleted_at IS NULL LIMIT 1;
 requirements:=veo_receipt_requirements(r.submitted_by,r.contact_id,r.seller_id,r.receipt_kind,r.order_id,true);
 IF NOT(requirements->>'allowed')::boolean THEN RETURN NULL;END IF;
 RETURN veo_handoff_before_facebook(p_submission);
END $$;

-- Close the older photo submission path; all new uploads use strict Receipts.
ALTER FUNCTION veo_action(uuid,text,jsonb) RENAME TO veo_action_before_receipt_gate;
CREATE FUNCTION veo_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_action='submission' THEN RAISE EXCEPTION 'Submit through Receipts after checking the Facebook requirements';END IF;
 RETURN veo_action_before_receipt_gate(p_actor,p_action,p_data);
END $$;
DO $$ DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_facebook_check_context','veo_record_facebook_check','veo_receipt_requirements','veo_receipt_facts','veo_receipt_save','veo_receipt_recheck','veo_submission_facebook_context','veo_handoff','veo_action') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
