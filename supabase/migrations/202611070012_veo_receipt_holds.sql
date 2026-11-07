BEGIN;
ALTER TABLE veo_submissions ADD COLUMN receipt_kind text NOT NULL DEFAULT 'done' CHECK(receipt_kind IN('closed','done'));
DROP INDEX IF EXISTS veo_submissions_order_id_idx;
DO $$ DECLARE idx record;BEGIN
 FOR idx IN SELECT indexrelid::regclass AS name FROM pg_index WHERE indrelid='veo_submissions'::regclass AND indisunique AND indpred IS NOT NULL AND pg_get_indexdef(indexrelid) LIKE '%(order_id)%' LOOP EXECUTE format('DROP INDEX %s',idx.name);END LOOP;
END $$;
CREATE UNIQUE INDEX veo_submission_order_milestone ON veo_submissions(order_id,receipt_kind) WHERE status IN('queued','processing','delivered');
CREATE TABLE veo_receipts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL UNIQUE,
 tenant_id uuid NOT NULL REFERENCES veo_tenants(id),page_id uuid NOT NULL REFERENCES pages(id),contact_id uuid NOT NULL REFERENCES contacts(id),
 seller_id uuid NOT NULL REFERENCES veo_accounts(user_id),submitted_by uuid NOT NULL REFERENCES users(id),
 receipt_kind text NOT NULL CHECK(receipt_kind IN('closed','done')),order_id uuid REFERENCES veo_orders(id),
 object_path text NOT NULL UNIQUE REFERENCES veo_photo_objects(object_path),photo_sha256 text NOT NULL CHECK(photo_sha256~'^[a-f0-9]{64}$'),
 delivery_submission uuid REFERENCES veo_submissions(id),created_at timestamptz NOT NULL DEFAULT now(),checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX veo_receipts_scope ON veo_receipts(tenant_id,seller_id,page_id,created_at DESC);
CREATE INDEX veo_receipts_contact ON veo_receipts(contact_id,seller_id,receipt_kind);
ALTER TABLE veo_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_receipts FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_receipts TO service_role;

CREATE FUNCTION veo_receipt_facts(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE r veo_receipts;o veo_order_facts;c contacts;s veo_submissions;holds jsonb:='[]';salary_holds jsonb:='[]';tg veo_teams;deleted boolean;BEGIN
 SELECT * INTO r FROM veo_receipts WHERE id=p_id;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO c FROM contacts WHERE id=r.contact_id AND page_id=r.page_id;
 SELECT * INTO o FROM veo_order_facts WHERE id=r.order_id;
 SELECT * INTO s FROM veo_submissions WHERE id=r.delivery_submission;
 SELECT deleted_at IS NOT NULL OR expires_at<=now() INTO deleted FROM veo_photo_objects WHERE object_path=r.object_path;
 IF c.pipeline_stage IS DISTINCT FROM 'converted' THEN salary_holds:=salary_holds||'"converted_lead_required"'::jsonb;END IF;
 IF o.id IS NULL THEN salary_holds:=salary_holds||'"create_and_link_order"'::jsonb;
 ELSE
  IF o.contact_id<>r.contact_id OR o.page_id<>r.page_id OR o.seller_id<>r.seller_id THEN salary_holds:=salary_holds||'"seller_or_order_attribution_changed"'::jsonb;END IF;
  IF o.paid_minor<>o.total_minor OR o.done_at IS NULL THEN salary_holds:=salary_holds||'"verify_full_payment"'::jsonb;END IF;
 END IF;
 holds:=salary_holds;
 IF r.receipt_kind='closed' AND o.id IS NOT NULL AND o.paid_minor>0 AND o.closed_at IS NOT NULL THEN holds:=holds-'verify_full_payment';END IF;
 IF coalesce(deleted,true) AND s.status IS DISTINCT FROM 'delivered' THEN holds:=holds||'"photo_expired_reupload"'::jsonb;END IF;
 IF NOT veo_can_page(r.seller_id,r.page_id) OR NOT veo_can_page(r.submitted_by,r.page_id) OR r.seller_id NOT IN(SELECT veo_descendants(r.submitted_by)) THEN holds:=holds||'"staff_or_page_access_changed"'::jsonb;END IF;
 SELECT * INTO tg FROM veo_teams WHERE id=o.team_id;
 IF tg.telegram_chat_id IS NULL OR NOT EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=r.seller_id) THEN holds:=holds||'"telegram_mapping_required"'::jsonb;END IF;
 RETURN (to_jsonb(r)-'object_path'-'photo_sha256')||jsonb_build_object('contact_name',c.name,'lead_stage',c.pipeline_stage,
 'seller_name',(SELECT name FROM users WHERE id=r.seller_id),'page_name',(SELECT name FROM pages WHERE id=r.page_id),
 'order_description',o.description,'currency',o.currency,'total_minor',o.total_minor,'paid_minor',o.paid_minor,
 'closed_at',o.closed_at,'done_at',o.done_at,'expires_at',(SELECT expires_at FROM veo_photo_objects WHERE object_path=r.object_path),
 'holds',holds,'salary_holds',salary_holds,'salary_status',CASE WHEN jsonb_array_length(salary_holds)>0 THEN 'on_hold' ELSE 'counted_from_verified_ledger' END,
 'delivery_status',coalesce(s.status,CASE WHEN jsonb_array_length(holds)>0 THEN 'on_hold' ELSE 'ready_to_queue' END),
 'last_error',s.last_error,'delivered_at',s.delivered_at,'photo_available',NOT coalesce(deleted,true),
 'order_options',coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'description',x.description,'currency',x.currency,'total_minor',x.total_minor) ORDER BY x.created_at DESC)
 FROM veo_orders x WHERE x.contact_id=r.contact_id AND x.seller_id=r.seller_id AND x.page_id=r.page_id),'[]'));
END $$;

CREATE FUNCTION veo_receipt_access(p_actor uuid,p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_receipts;BEGIN
 SELECT * INTO r FROM veo_receipts WHERE id=p_id;
 IF r.id IS NULL OR NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=p_actor AND active AND tenant_id=r.tenant_id)
 OR NOT veo_can_page(p_actor,r.page_id) OR r.seller_id NOT IN(SELECT veo_branch(p_actor)) THEN RAISE EXCEPTION 'Receipt outside your permitted seller branch or Page' USING ERRCODE='42501';END IF;
 RETURN veo_receipt_facts(p_id);
END $$;

CREATE FUNCTION veo_receipt_recheck(p_actor uuid,p_id uuid,p_order uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_receipts;f jsonb;sid uuid;before_order uuid;BEGIN
 PERFORM veo_receipt_access(p_actor,p_id);
 SELECT * INTO r FROM veo_receipts WHERE id=p_id FOR UPDATE;
 IF p_order IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM veo_orders WHERE id=p_order AND tenant_id=r.tenant_id AND page_id=r.page_id AND contact_id=r.contact_id AND seller_id=r.seller_id) THEN RAISE EXCEPTION 'Choose this seller''s order for this contact';END IF;
  before_order:=r.order_id;
  IF r.delivery_submission IS NOT NULL AND r.order_id IS DISTINCT FROM p_order THEN RAISE EXCEPTION 'A queued or delivered receipt cannot move to another order';END IF;
  UPDATE veo_receipts SET order_id=p_order WHERE id=r.id;
  IF before_order IS DISTINCT FROM p_order THEN INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value) VALUES(r.tenant_id,p_actor,'receipt_order_link',r.id,to_jsonb(before_order),to_jsonb(p_order));END IF;
 END IF;
 UPDATE veo_receipts SET checked_at=clock_timestamp() WHERE id=r.id;
 f:=veo_receipt_facts(r.id);
 IF jsonb_array_length(f->'holds')=0 AND r.delivery_submission IS NULL THEN
  SELECT id INTO sid FROM veo_submissions WHERE order_id=(f->>'order_id')::uuid AND receipt_kind=r.receipt_kind AND status IN('queued','processing','delivered') ORDER BY created_at LIMIT 1;
  IF sid IS NULL THEN
   INSERT INTO veo_submissions(order_id,submitted_by,object_path,expires_at,receipt_kind)
   VALUES((f->>'order_id')::uuid,r.submitted_by,r.object_path,(f->>'expires_at')::timestamptz,r.receipt_kind)
   ON CONFLICT(order_id,receipt_kind) WHERE status IN('queued','processing','delivered') DO NOTHING RETURNING id INTO sid;
   IF sid IS NULL THEN SELECT id INTO sid FROM veo_submissions WHERE order_id=(f->>'order_id')::uuid AND receipt_kind=r.receipt_kind AND status IN('queued','processing','delivered') LIMIT 1;END IF;
  END IF;
  UPDATE veo_receipts SET delivery_submission=sid WHERE id=r.id;
 ELSIF jsonb_array_length(f->'holds')=0 AND f->>'delivery_status'='blocked' AND coalesce(f->>'last_error','') NOT ILIKE '%duplicate%' AND coalesce(f->>'last_error','') NOT ILIKE '%acknowledgment%' THEN
  UPDATE veo_submissions SET status='queued',next_attempt_at=now(),last_error=NULL WHERE id=r.delivery_submission AND status='blocked';
 END IF;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(r.tenant_id,p_actor,'receipt_recheck',r.id,jsonb_build_object('holds',f->'holds','salary_holds',f->'salary_holds'));
 RETURN veo_receipt_facts(r.id);
END $$;

CREATE FUNCTION veo_receipt_save(p_actor uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;c contacts;seller uuid;rid uuid;existing uuid;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 SELECT * INTO c FROM contacts WHERE id=(p_data->>'contact_id')::uuid;
 seller:=coalesce((p_data->>'seller_id')::uuid,p_actor);
 IF a.user_id IS NULL OR c.id IS NULL OR NOT veo_can_page(p_actor,c.page_id) OR seller NOT IN(SELECT veo_descendants(p_actor)) OR NOT veo_can_page(seller,c.page_id)
 OR NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=seller AND tenant_id=a.tenant_id AND active AND role IN('manager','member')) THEN RAISE EXCEPTION 'Choose an authorized selling worker and contact' USING ERRCODE='42501';END IF;
 IF p_data->>'receipt_kind' NOT IN('closed','done') OR coalesce(p_data->>'object_path','') NOT LIKE a.tenant_id::text||'/'||p_actor::text||'/%'
 OR NOT EXISTS(SELECT 1 FROM veo_photo_objects WHERE object_path=p_data->>'object_path' AND expires_at>now() AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Private receipt upload is required';END IF;
 SELECT r.id INTO existing FROM veo_receipts r JOIN veo_photo_objects p USING(object_path) WHERE r.tenant_id=a.tenant_id AND r.contact_id=c.id AND r.seller_id=seller AND r.receipt_kind=p_data->>'receipt_kind'
 AND(r.request_id=(p_data->>'request_id')::uuid OR(r.photo_sha256=p_data->>'photo_sha256' AND r.order_id IS NOT DISTINCT FROM nullif(p_data->>'order_id','')::uuid AND p.expires_at>now() AND p.deleted_at IS NULL)) LIMIT 1;
 IF existing IS NOT NULL THEN RETURN veo_receipt_access(p_actor,existing)||jsonb_build_object('duplicate',true);END IF;
 IF nullif(p_data->>'order_id','') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM veo_orders WHERE id=(p_data->>'order_id')::uuid AND tenant_id=a.tenant_id AND contact_id=c.id AND page_id=c.page_id AND seller_id=seller) THEN RAISE EXCEPTION 'Choose this seller''s order for this contact';END IF;
 INSERT INTO veo_receipts(request_id,tenant_id,page_id,contact_id,seller_id,submitted_by,receipt_kind,order_id,object_path,photo_sha256)
 VALUES((p_data->>'request_id')::uuid,a.tenant_id,c.page_id,c.id,seller,p_actor,p_data->>'receipt_kind',nullif(p_data->>'order_id','')::uuid,p_data->>'object_path',p_data->>'photo_sha256') RETURNING id INTO rid;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(a.tenant_id,p_actor,'receipt_submitted',rid,jsonb_build_object('seller_id',seller,'kind',p_data->>'receipt_kind','contact_id',c.id));
 RETURN veo_receipt_recheck(p_actor,rid);
END $$;

CREATE FUNCTION veo_receipts_page(p_actor uuid,p_from date,p_to date,p_seller uuid DEFAULT NULL,p_page uuid DEFAULT NULL,p_offset integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE tenant uuid;result jsonb;BEGIN
 SELECT tenant_id INTO tenant FROM veo_accounts WHERE user_id=p_actor AND active;
 IF tenant IS NULL OR p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page) OR p_seller IS NOT NULL AND p_seller NOT IN(SELECT veo_branch(p_actor)) THEN RAISE EXCEPTION 'Receipt access denied' USING ERRCODE='42501';END IF;
 IF p_to<p_from OR p_to-p_from>93 OR p_offset<0 OR p_offset>100000 THEN RAISE EXCEPTION 'Choose at most 94 days';END IF;
 WITH scoped AS MATERIALIZED(SELECT r.id,r.created_at FROM veo_receipts r WHERE r.tenant_id=tenant AND r.seller_id IN(SELECT veo_branch(p_actor)) AND veo_can_page(p_actor,r.page_id)
 AND(p_page IS NULL OR r.page_id=p_page) AND(p_seller IS NULL OR r.seller_id=p_seller) AND r.created_at>=(p_from::timestamp AT TIME ZONE 'Asia/Manila') AND r.created_at<((p_to+1)::timestamp AT TIME ZONE 'Asia/Manila'))
 SELECT jsonb_build_object('total',(SELECT count(*) FROM scoped),'items',coalesce((SELECT jsonb_agg(veo_receipt_facts(s.id) ORDER BY s.created_at DESC,s.id) FROM(SELECT * FROM scoped ORDER BY created_at DESC,id LIMIT 50 OFFSET p_offset) s),'[]')) INTO result;
 RETURN result;
END $$;

-- Legacy Done Deal handoffs remain compatible. Closed Deal evidence has a
-- separate idempotency key and requires a verified positive first payment.
DO $migration$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_handoff(uuid)'::regprocedure);
 IF strpos(definition,'o.paid_minor<>o.total_minor OR o.done_at IS NULL')=0 THEN RAISE EXCEPTION 'Expected handoff payment gate is missing';END IF;
 definition:=replace(definition,'o.paid_minor<>o.total_minor OR o.done_at IS NULL',
 '(s.receipt_kind=''done'' AND(o.paid_minor<>o.total_minor OR o.done_at IS NULL)) OR(s.receipt_kind=''closed'' AND(o.paid_minor<=0 OR o.closed_at IS NULL))');
 definition:=replace(definition,'''submission_id'',s.id,','''submission_id'',s.id,''receipt_kind'',s.receipt_kind,');
 EXECUTE definition;
END $migration$;
DO $$ DECLARE fn record;BEGIN
 FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_receipt_facts','veo_receipt_access','veo_receipt_recheck','veo_receipt_save','veo_receipts_page') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
