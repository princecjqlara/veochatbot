BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE TABLE veo_deal_review_settings(tenant_id uuid PRIMARY KEY REFERENCES veo_tenants(id),enabled boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE veo_deal_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL UNIQUE,
 tenant_id uuid NOT NULL REFERENCES veo_tenants(id),page_id uuid NOT NULL REFERENCES pages(id),contact_id uuid NOT NULL REFERENCES contacts(id),
 seller_id uuid NOT NULL REFERENCES veo_accounts(user_id),submitted_by uuid NOT NULL REFERENCES users(id),
 receipt_kind text NOT NULL CHECK(receipt_kind IN('closed','done')),status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
 currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),total_price_minor bigint NOT NULL CHECK(total_price_minor BETWEEN 1 AND 9000000000000),
 closed_amount_minor bigint NOT NULL DEFAULT 0 CHECK(closed_amount_minor BETWEEN 0 AND 9000000000000),
 received_now_minor bigint NOT NULL DEFAULT 0 CHECK(received_now_minor BETWEEN 0 AND 9000000000000),tip_minor bigint NOT NULL DEFAULT 0 CHECK(tip_minor BETWEEN 0 AND 9000000000000),
 occurred_at timestamptz NOT NULL,description text NOT NULL DEFAULT 'Reviewed video deal',invoice_reference text,notes text NOT NULL DEFAULT '',
 order_id uuid REFERENCES veo_orders(id),closed_deal_id uuid REFERENCES veo_closed_deals(id),existing_closed_payment_id uuid REFERENCES veo_payments(id),
 reviewed_by uuid REFERENCES users(id),reviewed_at timestamptz,review_note text,
 delivery_submission uuid REFERENCES veo_submissions(id),payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(receipt_kind<>'closed' OR(closed_amount_minor>0 AND closed_amount_minor<=total_price_minor AND received_now_minor=0 AND tip_minor=0))
);
CREATE UNIQUE INDEX veo_deal_review_approved_order ON veo_deal_reviews(order_id,receipt_kind) WHERE status='approved';
CREATE INDEX veo_deal_review_inbox ON veo_deal_reviews(tenant_id,status,created_at DESC,id);
CREATE TABLE veo_deal_review_photos(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),request_id uuid NOT NULL,tenant_id uuid NOT NULL REFERENCES veo_tenants(id),
 page_id uuid NOT NULL REFERENCES pages(id),contact_id uuid NOT NULL REFERENCES contacts(id),seller_id uuid NOT NULL REFERENCES veo_accounts(user_id),uploaded_by uuid NOT NULL REFERENCES users(id),
 receipt_kind text NOT NULL CHECK(receipt_kind IN('closed','done')),slot text NOT NULL CHECK(slot IN('stage','payment','order')),
 object_path text NOT NULL UNIQUE REFERENCES veo_photo_objects(object_path),photo_sha256 text NOT NULL CHECK(photo_sha256~'^[a-f0-9]{64}$'),
 review_id uuid REFERENCES veo_deal_reviews(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX veo_deal_review_photo_slot ON veo_deal_review_photos(review_id,slot) WHERE review_id IS NOT NULL;
CREATE TABLE veo_deal_tips(review_id uuid PRIMARY KEY REFERENCES veo_deal_reviews(id),order_id uuid NOT NULL REFERENCES veo_orders(id),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),received_at timestamptz NOT NULL,verified_by uuid NOT NULL REFERENCES users(id));
ALTER TABLE veo_submissions ADD COLUMN deal_review_id uuid UNIQUE REFERENCES veo_deal_reviews(id);

CREATE FUNCTION veo_reviewed_deals_enabled(p_tenant uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT enabled FROM veo_deal_review_settings WHERE tenant_id=p_tenant),false)
$$;
ALTER FUNCTION veo_scope(uuid) RENAME TO veo_scope_before_deal_review;
CREATE FUNCTION veo_scope(p_actor uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;BEGIN result:=veo_scope_before_deal_review(p_actor);IF result IS NULL THEN RETURN NULL;END IF;
 RETURN result||jsonb_build_object('reviewed_deals_enabled',veo_reviewed_deals_enabled((result->>'tenant_id')::uuid));END $$;

CREATE FUNCTION veo_deal_review_context(p_actor uuid,p_contact uuid,p_seller uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE a veo_accounts;w veo_accounts;c contacts;team uuid;BEGIN
 SELECT x.* INTO a FROM veo_accounts x JOIN users u ON u.id=x.user_id AND u.is_active WHERE x.user_id=p_actor AND x.active;
 SELECT * INTO c FROM contacts WHERE id=p_contact;
 SELECT x.* INTO w FROM veo_accounts x JOIN users u ON u.id=x.user_id AND u.is_active WHERE x.user_id=p_seller AND x.active AND x.role IN('member','manager') AND x.tenant_id=a.tenant_id;
 IF a.user_id IS NULL OR w.user_id IS NULL OR c.id IS NULL OR NOT veo_reviewed_deals_enabled(a.tenant_id)
 OR p_seller NOT IN(SELECT veo_descendants(p_actor)) OR NOT veo_can_page(p_actor,c.page_id) OR NOT veo_can_page(p_seller,c.page_id) THEN
 RAISE EXCEPTION 'Choose a permitted contact and selling staff account' USING ERRCODE='42501';END IF;
 SELECT id INTO team FROM veo_teams WHERE tenant_id=a.tenant_id AND manager_id=CASE WHEN w.role='manager' THEN w.user_id ELSE w.parent_id END;
 IF team IS NULL THEN RAISE EXCEPTION 'The seller needs a Team Leader or Manager team';END IF;
 RETURN jsonb_build_object('tenant_id',a.tenant_id,'page_id',c.page_id,'contact_id',c.id,'seller_id',w.user_id,'team_id',team,'launch_at',(SELECT launch_at FROM veo_tenants WHERE id=a.tenant_id));
END $$;

CREATE FUNCTION veo_deal_review_facts(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (to_jsonb(r)-'payload')||jsonb_build_object('client_name',c.name,'page_name',p.name,'seller_name',u.name,'reviewer_name',v.name,
 'photos',coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'slot',f.slot,'available',o.deleted_at IS NULL AND o.expires_at>now()) ORDER BY f.slot)
 FROM veo_deal_review_photos f JOIN veo_photo_objects o USING(object_path) WHERE f.review_id=r.id),'[]'),
 'delivery_status',coalesce(s.status,CASE WHEN r.status='approved' THEN 'waiting_for_telegram_setup' ELSE 'awaiting_review' END),
 'delivery_error',s.last_error,'delivered_at',s.delivered_at,'tip_commission_included',false)
 FROM veo_deal_reviews r JOIN contacts c ON c.id=r.contact_id JOIN pages p ON p.id=r.page_id JOIN users u ON u.id=r.seller_id
 LEFT JOIN users v ON v.id=r.reviewed_by LEFT JOIN veo_submissions s ON s.id=r.delivery_submission WHERE r.id=p_id
$$;
CREATE FUNCTION veo_deal_review_access(p_actor uuid,p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_deal_reviews;a veo_accounts;BEGIN
 SELECT * INTO r FROM veo_deal_reviews WHERE id=p_id;SELECT x.* INTO a FROM veo_accounts x JOIN users u ON u.id=x.user_id AND u.is_active WHERE x.user_id=p_actor AND x.active;
 IF a.user_id IS NULL OR r.id IS NULL OR a.tenant_id<>r.tenant_id OR NOT veo_can_page(p_actor,r.page_id) OR r.seller_id NOT IN(SELECT veo_branch(p_actor)) THEN RAISE EXCEPTION 'Deal evidence outside your branch or Page' USING ERRCODE='42501';END IF;
 RETURN veo_deal_review_facts(r.id)||jsonb_build_object('can_review',a.role IN('owner','team_leader','manager') AND a.user_id NOT IN(r.seller_id,r.submitted_by) AND r.status='pending');
END $$;
CREATE FUNCTION veo_deal_reviews_page(p_actor uuid,p_status text DEFAULT 'all',p_contact uuid DEFAULT NULL,p_offset integer DEFAULT 0,p_limit integer DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE a veo_accounts;items jsonb;total integer;BEGIN
 SELECT x.* INTO a FROM veo_accounts x JOIN users u ON u.id=x.user_id AND u.is_active WHERE x.user_id=p_actor AND x.active;
 IF a.user_id IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501';END IF;
 IF p_status NOT IN('all','pending','approved','rejected') OR p_offset<0 OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid review filters';END IF;
 SELECT count(*)::int INTO total FROM veo_deal_reviews r WHERE r.tenant_id=a.tenant_id AND(p_status='all' OR r.status=p_status) AND(p_contact IS NULL OR r.contact_id=p_contact) AND veo_can_page(p_actor,r.page_id) AND r.seller_id IN(SELECT veo_branch(p_actor));
 SELECT coalesce(jsonb_agg(veo_deal_review_access(p_actor,r.id) ORDER BY r.created_at DESC,r.id),'[]') INTO items FROM(
 SELECT x.* FROM veo_deal_reviews x WHERE x.tenant_id=a.tenant_id AND(p_status='all' OR x.status=p_status) AND(p_contact IS NULL OR x.contact_id=p_contact) AND veo_can_page(p_actor,x.page_id) AND x.seller_id IN(SELECT veo_branch(p_actor)) ORDER BY x.created_at DESC,x.id OFFSET p_offset LIMIT p_limit) r;
 RETURN jsonb_build_object('items',items,'total',total,'offset',p_offset,'limit',p_limit);
END $$;

CREATE FUNCTION veo_submit_deal_review(p_actor uuid,p_data jsonb,p_photos uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE context jsonb;r veo_deal_reviews;existing veo_deal_reviews;kind text;total bigint;closed bigint;received bigint;tip bigint;at timestamptz;payload jsonb;o veo_orders;d veo_closed_deals;BEGIN
 context:=veo_deal_review_context(p_actor,(p_data->>'contact_id')::uuid,(p_data->>'seller_id')::uuid);
 kind:=p_data->>'receipt_kind';total:=(p_data->>'total_price_minor')::bigint;closed:=coalesce((p_data->>'closed_amount_minor')::bigint,0);received:=coalesce((p_data->>'received_now_minor')::bigint,0);tip:=coalesce((p_data->>'tip_minor')::bigint,0);at:=(p_data->>'occurred_at')::timestamptz;
 IF kind NOT IN('closed','done') OR total IS NULL OR total NOT BETWEEN 1 AND 9000000000000 OR closed NOT BETWEEN 0 AND total OR received NOT BETWEEN 0 AND 9000000000000 OR tip NOT BETWEEN 0 AND 9000000000000 OR at IS NULL OR at<(context->>'launch_at')::timestamptz OR at>clock_timestamp()+interval '1 minute' OR length(coalesce(p_data->>'notes',''))>2000 OR length(coalesce(p_data->>'description',''))>500 OR length(coalesce(p_data->>'invoice_reference',''))>160 THEN RAISE EXCEPTION 'Check the deal amounts, currency and payment date';END IF;
 IF p_data->>'currency' IS NULL OR p_data->>'currency' !~ '^[A-Z]{3}$' OR kind='closed' AND(closed<=0 OR received<>0 OR tip<>0) OR kind='done' AND closed<>0 THEN RAISE EXCEPTION 'Enter separate Close Deal, Done Deal and tip amounts';END IF;
 IF cardinality(p_photos)<>3 OR(SELECT count(DISTINCT id) FROM unnest(p_photos) id)<>3 THEN RAISE EXCEPTION 'Three different evidence photos are required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('veo-deal-review:'||(p_data->>'request_id'),0));
 SELECT * INTO existing FROM veo_deal_reviews WHERE request_id=(p_data->>'request_id')::uuid;
 payload:=p_data||jsonb_build_object('photo_ids',(SELECT jsonb_agg(id ORDER BY id) FROM unnest(p_photos) id));
 IF existing.id IS NOT NULL THEN
  IF existing.submitted_by<>p_actor OR existing.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'This submission reference already has different evidence or amounts' USING ERRCODE='23505';END IF;
  RETURN veo_deal_review_access(p_actor,existing.id)||jsonb_build_object('duplicate',true);
 END IF;
 IF(SELECT count(*) FROM veo_deal_review_photos f JOIN veo_photo_objects b USING(object_path) WHERE f.id=ANY(p_photos) AND f.request_id=(p_data->>'request_id')::uuid AND f.uploaded_by=p_actor AND f.tenant_id=(context->>'tenant_id')::uuid AND f.contact_id=(context->>'contact_id')::uuid AND f.seller_id=(context->>'seller_id')::uuid AND f.receipt_kind=kind AND f.review_id IS NULL AND b.deleted_at IS NULL AND b.expires_at>now())<>3 OR(SELECT count(DISTINCT slot) FROM veo_deal_review_photos WHERE id=ANY(p_photos))<>3 OR(SELECT count(DISTINCT photo_sha256) FROM veo_deal_review_photos WHERE id=ANY(p_photos))<>3 THEN RAISE EXCEPTION 'Upload current stage, receipt and order photos for this selected contact';END IF;
 IF nullif(p_data->>'closed_deal_id','') IS NOT NULL THEN
  SELECT * INTO d FROM veo_closed_deals WHERE id=(p_data->>'closed_deal_id')::uuid AND voided_at IS NULL;
  IF kind<>'done' OR d.id IS NULL OR(d.tenant_id,d.page_id,d.contact_id,d.seller_id,d.currency) IS DISTINCT FROM((context->>'tenant_id')::uuid,(context->>'page_id')::uuid,(context->>'contact_id')::uuid,(context->>'seller_id')::uuid,p_data->>'currency') THEN RAISE EXCEPTION 'Choose this contact and seller''s existing Close Deal';END IF;
 END IF;
 IF coalesce(nullif(p_data->>'order_id','')::uuid,d.order_id) IS NOT NULL THEN
  SELECT * INTO o FROM veo_orders WHERE id=coalesce(nullif(p_data->>'order_id','')::uuid,d.order_id);
  IF o.id IS NULL OR(o.tenant_id,o.page_id,o.contact_id,o.seller_id,o.currency,o.total_minor) IS DISTINCT FROM((context->>'tenant_id')::uuid,(context->>'page_id')::uuid,(context->>'contact_id')::uuid,(context->>'seller_id')::uuid,p_data->>'currency',total) OR d.order_id IS NOT NULL AND d.order_id<>o.id THEN RAISE EXCEPTION 'The existing order and total price must match the selected client and seller';END IF;
 END IF;
 INSERT INTO veo_deal_reviews(request_id,tenant_id,page_id,contact_id,seller_id,submitted_by,receipt_kind,currency,total_price_minor,closed_amount_minor,received_now_minor,tip_minor,occurred_at,description,invoice_reference,notes,order_id,closed_deal_id,existing_closed_payment_id,payload)
 VALUES((p_data->>'request_id')::uuid,(context->>'tenant_id')::uuid,(context->>'page_id')::uuid,(context->>'contact_id')::uuid,(context->>'seller_id')::uuid,p_actor,kind,p_data->>'currency',total,closed,received,tip,at,coalesce(nullif(p_data->>'description',''),'Reviewed video deal'),nullif(btrim(p_data->>'invoice_reference'),''),coalesce(p_data->>'notes',''),o.id,d.id,nullif(p_data->>'existing_closed_payment_id','')::uuid,payload) RETURNING * INTO r;
 UPDATE veo_deal_review_photos SET review_id=r.id WHERE id=ANY(p_photos);
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value) VALUES(r.tenant_id,p_actor,'deal_evidence_submitted',r.id,jsonb_build_object('kind',kind,'photos',3,'status','pending'));
 RETURN veo_deal_review_access(p_actor,r.id)||jsonb_build_object('duplicate',false);
END $$;

CREATE FUNCTION veo_queue_reviewed_deal(p_review uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE r veo_deal_reviews;o veo_orders;dest jsonb;path text;until_at timestamptz;sid uuid;BEGIN
 SELECT * INTO r FROM veo_deal_reviews WHERE id=p_review AND status='approved' FOR UPDATE;
 IF r.id IS NULL OR NOT veo_reviewed_deals_enabled(r.tenant_id) OR NOT veo_can_page(r.seller_id,r.page_id) OR NOT EXISTS(SELECT 1 FROM veo_accounts a JOIN users u ON u.id=a.user_id AND u.is_active WHERE a.user_id=r.seller_id AND a.active) THEN RETURN false;END IF;
 SELECT * INTO o FROM veo_orders WHERE id=r.order_id;dest:=veo_telegram_destination(o.team_id,r.page_id,r.seller_id);
 IF dest->>'chat_id' IS NULL OR NOT EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=r.seller_id) THEN RETURN false;END IF;
 SELECT min(b.expires_at) INTO until_at FROM veo_deal_review_photos f JOIN veo_photo_objects b USING(object_path) WHERE f.review_id=r.id AND b.deleted_at IS NULL;
 IF until_at<=now() OR(SELECT count(*) FROM veo_deal_review_photos f JOIN veo_photo_objects b USING(object_path) WHERE f.review_id=r.id AND b.deleted_at IS NULL AND b.expires_at>now())<>3 THEN RETURN false;END IF;
 IF r.delivery_submission IS NOT NULL THEN RETURN true;END IF;
 SELECT object_path INTO path FROM veo_deal_review_photos WHERE review_id=r.id AND slot='payment';
 INSERT INTO veo_submissions(order_id,submitted_by,object_path,expires_at,receipt_kind,closed_deal_id,deal_review_id)
 VALUES(o.id,r.submitted_by,path,until_at,r.receipt_kind,CASE WHEN r.receipt_kind='closed' THEN r.closed_deal_id END,r.id) ON CONFLICT DO NOTHING RETURNING id INTO sid;
 IF sid IS NULL THEN SELECT id INTO sid FROM veo_submissions WHERE deal_review_id=r.id;END IF;
 IF sid IS NULL THEN RETURN false;END IF;
 UPDATE veo_deal_reviews SET delivery_submission=sid WHERE id=r.id;RETURN true;
END $$;

CREATE FUNCTION veo_review_deal(p_actor uuid,p_review uuid,p_decision text,p_confirm_stage boolean DEFAULT false,p_confirm_receipt boolean DEFAULT false,p_confirm_order boolean DEFAULT false,p_note text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off SET lock_timeout='5s' AS $$
DECLARE r veo_deal_reviews;a veo_accounts;context jsonb;o veo_orders;d veo_closed_deals;f veo_order_facts;deposit bigint:=0;payment uuid;at timestamptz;BEGIN
 PERFORM veo_deal_review_access(p_actor,p_review);SELECT * INTO r FROM veo_deal_reviews WHERE id=p_review FOR UPDATE;
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF a.role NOT IN('owner','team_leader','manager') OR p_actor IN(r.seller_id,r.submitted_by) THEN RAISE EXCEPTION 'A different authorized supervisor must review this submission' USING ERRCODE='42501';END IF;
 IF p_decision NOT IN('approve','reject') OR p_decision IS NULL OR length(coalesce(p_note,''))>2000 THEN RAISE EXCEPTION 'Choose approve or reject and a valid note';END IF;
 IF r.status<>'pending' THEN
  IF r.reviewed_by=p_actor AND r.status=(CASE WHEN p_decision='approve' THEN 'approved' ELSE 'rejected' END) THEN RETURN veo_deal_review_access(p_actor,r.id);END IF;
  RAISE EXCEPTION 'This submission was already reviewed. Refresh its status' USING ERRCODE='23505';
 END IF;
 IF p_decision='reject' THEN
  IF length(btrim(coalesce(p_note,'')))<3 THEN RAISE EXCEPTION 'Enter the rejection reason';END IF;
  UPDATE veo_deal_reviews SET status='rejected',reviewed_by=p_actor,reviewed_at=clock_timestamp(),review_note=btrim(p_note) WHERE id=r.id;
 ELSE
  IF p_confirm_stage IS NOT TRUE OR p_confirm_receipt IS NOT TRUE OR p_confirm_order IS NOT TRUE THEN RAISE EXCEPTION 'Confirm the stage photo, payment receipt and order photo';END IF;
  context:=veo_deal_review_context(p_actor,r.contact_id,r.seller_id);
  PERFORM 1 FROM contacts WHERE id=r.contact_id FOR UPDATE;
  IF(SELECT count(*) FROM veo_deal_review_photos p JOIN veo_photo_objects b USING(object_path) WHERE p.review_id=r.id AND b.deleted_at IS NULL AND b.expires_at>now())<>3 THEN RAISE EXCEPTION 'Evidence expired or is incomplete. Ask the staff member to resubmit';END IF;
  IF r.closed_deal_id IS NOT NULL THEN SELECT * INTO d FROM veo_closed_deals WHERE id=r.closed_deal_id AND voided_at IS NULL FOR UPDATE;IF d.id IS NULL OR(d.tenant_id,d.page_id,d.contact_id,d.seller_id,d.currency) IS DISTINCT FROM(r.tenant_id,r.page_id,r.contact_id,r.seller_id,r.currency) OR r.order_id IS NOT NULL AND d.order_id IS DISTINCT FROM r.order_id THEN RAISE EXCEPTION 'The Close Deal changed. Resubmit for review';END IF;END IF;
  IF coalesce(r.order_id,d.order_id) IS NOT NULL THEN SELECT * INTO o FROM veo_orders WHERE id=coalesce(r.order_id,d.order_id) FOR UPDATE;
   IF o.id IS NULL OR(o.tenant_id,o.page_id,o.contact_id,o.seller_id,o.currency,o.total_minor) IS DISTINCT FROM(r.tenant_id,r.page_id,r.contact_id,r.seller_id,r.currency,r.total_price_minor) THEN RAISE EXCEPTION 'Order attribution or price changed. Resubmit for review';END IF;
  ELSE
   INSERT INTO veo_orders(request_id,tenant_id,team_id,page_id,contact_id,seller_id,description,total_minor,currency,created_by,deal_mode)
   VALUES(r.request_id,r.tenant_id,(context->>'team_id')::uuid,r.page_id,r.contact_id,r.seller_id,r.description,r.total_price_minor,r.currency,r.submitted_by,'new') RETURNING * INTO o;
  END IF;
  IF EXISTS(SELECT 1 FROM veo_deal_reviews WHERE order_id=o.id AND receipt_kind=r.receipt_kind AND status='approved' AND id<>r.id) THEN RAISE EXCEPTION 'This order already has an approved receipt for this milestone' USING ERRCODE='23505';END IF;
  IF r.receipt_kind='closed' THEN
   IF EXISTS(SELECT 1 FROM veo_order_facts WHERE id=o.id AND done_at IS NOT NULL) THEN RAISE EXCEPTION 'This order is already settled. Submit a Done Deal review';END IF;
   SELECT * INTO d FROM veo_closed_deals WHERE order_id=o.id AND voided_at IS NULL FOR UPDATE;
   IF d.id IS NULL THEN INSERT INTO veo_closed_deals(tenant_id,team_id,page_id,contact_id,seller_id,amount_minor,currency,occurred_at,created_by,order_id)
    VALUES(r.tenant_id,o.team_id,r.page_id,r.contact_id,r.seller_id,r.closed_amount_minor,r.currency,r.occurred_at,p_actor,o.id) RETURNING * INTO d;
   ELSIF d.amount_minor<>r.closed_amount_minor OR d.seller_id<>r.seller_id THEN RAISE EXCEPTION 'This order already has a different Close Deal amount';END IF;
  ELSE
   IF d.id IS NULL THEN SELECT * INTO d FROM veo_closed_deals WHERE order_id=o.id AND voided_at IS NULL FOR UPDATE;END IF;
   SELECT * INTO f FROM veo_order_facts WHERE id=o.id;
   IF d.id IS NOT NULL AND d.verified_payment_id IS NULL THEN
    IF f.paid_minor=0 THEN deposit:=d.amount_minor;
    ELSE
     SELECT id INTO payment FROM veo_payments WHERE id=r.existing_closed_payment_id AND order_id=o.id AND kind<>'refund' AND amount_minor>=d.amount_minor;
     IF payment IS NULL THEN RAISE EXCEPTION 'Select the saved payment covering the earlier Close Deal so it is not counted twice';END IF;
     UPDATE veo_closed_deals SET verified_payment_id=payment WHERE id=d.id;
    END IF;
   END IF;
   IF f.paid_minor+deposit+r.received_now_minor<=0 OR abs(f.paid_minor+deposit+r.received_now_minor-o.total_minor)>(CASE WHEN r.currency='PHP' THEN 200 ELSE 0 END) THEN RAISE EXCEPTION 'Earlier payments plus the Done Deal amount must settle the price. Enter the tip separately';END IF;
   UPDATE veo_orders SET settlement_tolerance_minor=CASE WHEN r.currency='PHP' THEN 200 ELSE 0 END WHERE id=o.id;
  END IF;
  -- Explicit human review is a manual stage decision, never a fabricated Meta event.
  UPDATE contacts SET pipeline_stage=CASE WHEN r.receipt_kind='done' THEN 'converted' WHEN pipeline_stage='converted' THEN 'converted' ELSE 'qualified' END,
   pipeline_stage_source='manual',pipeline_stage_updated_at=clock_timestamp() WHERE id=r.contact_id;
  IF r.receipt_kind='done' THEN
   IF deposit>0 THEN
    INSERT INTO veo_payments(request_id,order_id,kind,amount_minor,reference,occurred_at,verified_by) VALUES(gen_random_uuid(),o.id,'deposit',deposit,'REVIEWED-CD:'||d.id,d.occurred_at,p_actor) RETURNING id INTO payment;
    UPDATE veo_closed_deals SET verified_payment_id=payment WHERE id=d.id;
   END IF;
   IF r.received_now_minor>0 THEN
    INSERT INTO veo_payments(request_id,order_id,kind,amount_minor,reference,occurred_at,verified_by) VALUES(r.request_id,o.id,CASE WHEN d.id IS NULL THEN 'full' ELSE 'balance' END,r.received_now_minor,'DEAL-REVIEW:'||r.id,r.occurred_at,p_actor);
   END IF;
   IF NOT EXISTS(SELECT 1 FROM veo_order_facts WHERE id=o.id AND done_at IS NOT NULL) THEN RAISE EXCEPTION 'The approved payment must fully settle the order';END IF;
   IF r.tip_minor>0 THEN INSERT INTO veo_deal_tips(review_id,order_id,amount_minor,currency,received_at,verified_by) VALUES(r.id,o.id,r.tip_minor,r.currency,r.occurred_at,p_actor);END IF;
  END IF;
  UPDATE veo_deal_reviews SET status='approved',reviewed_by=p_actor,reviewed_at=clock_timestamp(),review_note=btrim(coalesce(p_note,'')),order_id=o.id,closed_deal_id=d.id WHERE id=r.id;
  PERFORM veo_queue_reviewed_deal(r.id);
 END IF;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(r.tenant_id,p_actor,'deal_evidence_'||p_decision,r.id,jsonb_build_object('kind',r.receipt_kind,'photos_confirmed',p_decision='approve'),nullif(btrim(p_note),''));
 RETURN veo_deal_review_access(p_actor,r.id);
END $$;

CREATE FUNCTION veo_enqueue_approved_deal_reviews(p_limit integer DEFAULT 20) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE r record;n integer:=0;BEGIN
 IF p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid review batch';END IF;
 FOR r IN SELECT d.id FROM veo_deal_reviews d WHERE status='approved' AND delivery_submission IS NULL ORDER BY reviewed_at LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
  IF veo_queue_reviewed_deal(r.id) THEN n:=n+1;END IF;
 END LOOP;RETURN n;END $$;

CREATE FUNCTION veo_reviewed_deal_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit=off AS $$
DECLARE s veo_submissions;r veo_deal_reviews;o veo_order_facts;d veo_closed_deals;dest jsonb;tg bigint;BEGIN
 SELECT * INTO s FROM veo_submissions WHERE id=p_submission AND status IN('queued','processing','delivered') AND deleted_at IS NULL AND expires_at>now();
 SELECT * INTO r FROM veo_deal_reviews WHERE id=s.deal_review_id AND status='approved' AND delivery_submission=s.id;
 IF r.id IS NULL OR NOT veo_reviewed_deals_enabled(r.tenant_id) OR NOT veo_can_page(r.seller_id,r.page_id) OR NOT EXISTS(SELECT 1 FROM veo_accounts a JOIN users u ON u.id=a.user_id AND u.is_active WHERE a.user_id=r.seller_id AND a.active) THEN RETURN NULL;END IF;
 SELECT * INTO o FROM veo_order_facts WHERE id=r.order_id;
 IF(o.tenant_id,o.page_id,o.contact_id,o.seller_id,o.currency,o.total_minor) IS DISTINCT FROM(r.tenant_id,r.page_id,r.contact_id,r.seller_id,r.currency,r.total_price_minor) OR NOT o.converted OR r.receipt_kind='done' AND(o.done_at IS NULL OR abs(o.paid_minor-o.total_minor)>o.settlement_tolerance_minor) THEN RETURN NULL;END IF;
 IF(SELECT count(*) FROM veo_deal_review_photos p JOIN veo_photo_objects b USING(object_path) WHERE p.review_id=r.id AND b.deleted_at IS NULL AND b.expires_at>now())<>3 THEN RETURN NULL;END IF;
 dest:=veo_telegram_destination(o.team_id,r.page_id,r.seller_id);SELECT telegram_user_id INTO tg FROM veo_worker_mappings WHERE user_id=r.seller_id;
 IF dest->>'chat_id' IS NULL OR tg IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO d FROM veo_closed_deals WHERE id=r.closed_deal_id AND voided_at IS NULL;
 RETURN jsonb_build_object('submission_id',s.id,'tenant_id',r.tenant_id,'team_id',o.team_id,'seller_id',r.seller_id,'page_id',r.page_id,'contact_id',r.contact_id,'order_id',o.id,'linked_order_id',o.id,
 'receipt_kind',r.receipt_kind,'closed_deal_id',d.id,'closed_amount_minor',coalesce(d.amount_minor,0),'total_minor',o.total_minor,'paid_minor',o.paid_minor,'done_amount_minor',r.received_now_minor,'tip_minor',r.tip_minor,
 'total_received_minor',CASE WHEN r.receipt_kind='closed' THEN r.closed_amount_minor ELSE o.paid_minor END+coalesce((SELECT sum(amount_minor) FROM veo_deal_tips WHERE order_id=o.id),0),
 'currency',r.currency,'lead_stage',CASE WHEN r.receipt_kind='closed' THEN 'qualified' ELSE 'converted' END,'closed_at',coalesce(d.occurred_at,o.closed_at,r.occurred_at),'done_at',o.done_at,
 'settlement_tolerance_minor',o.settlement_tolerance_minor,'payment_verified',r.receipt_kind='done','expires_at',s.expires_at,'telegram_chat_id',(dest->>'chat_id')::bigint,'telegram_thread_id',dest->'thread_id','telegram_user_id',tg,
 'seller_name',(SELECT name FROM users WHERE id=r.seller_id),'contact_name',(SELECT name FROM contacts WHERE id=r.contact_id),'page_name',(SELECT name FROM pages WHERE id=r.page_id),'description',r.description,
 'deal_review_id',r.id,'review_status',r.status,'reviewed_by',r.reviewed_by,'reviewer_name',(SELECT name FROM users WHERE id=r.reviewed_by),'reviewed_at',r.reviewed_at,'notes',r.notes,
 'evidence_photos',(SELECT jsonb_agg(jsonb_build_object('slot',p.slot,'object_path',p.object_path) ORDER BY CASE p.slot WHEN 'stage' THEN 1 WHEN 'payment' THEN 2 ELSE 3 END) FROM veo_deal_review_photos p WHERE p.review_id=r.id));
END $$;
ALTER FUNCTION veo_handoff(uuid) RENAME TO veo_handoff_before_reviewed_evidence;
CREATE FUNCTION veo_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM veo_submissions WHERE id=p_submission AND deal_review_id IS NOT NULL) THEN RETURN veo_reviewed_deal_handoff(p_submission);END IF;
 IF EXISTS(SELECT 1 FROM veo_submissions s JOIN veo_orders o ON o.id=s.order_id WHERE s.id=p_submission AND veo_reviewed_deals_enabled(o.tenant_id)) THEN RETURN NULL;END IF;
 RETURN veo_handoff_before_reviewed_evidence(p_submission);
END $$;

-- Apply the same new-inquiry cutoff to manual pool selection and old buttons.
-- Existing accepted clients and their sales remain available for servicing.
DO $$ DECLARE fn record;definition text;n integer:=0;needle text:='AND c.last_interaction_at>=launched';BEGIN
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'veo_intake_page%' AND strpos(prosrc,needle)>0 LOOP
  definition:=replace(pg_get_functiondef(fn.signature),needle,needle||' AND (NOT veo_reviewed_deals_enabled(a.tenant_id) OR (SELECT coalesce(original.first_interaction_at,original.created_at) FROM contacts original WHERE original.id=c.id)>=coalesce((SELECT enabled_at FROM veo_intake_auto_policy WHERE tenant_id=a.tenant_id AND enabled),launched))');
  EXECUTE definition;n:=n+1;
 END LOOP;
 IF n<>1 THEN RAISE EXCEPTION 'Expected one manual new-client pool cutoff';END IF;
END $$;
ALTER FUNCTION veo_intake_action(uuid,text,jsonb) RENAME TO veo_intake_action_before_reviewed_deals;
CREATE FUNCTION veo_intake_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a veo_accounts;c contacts;cutoff timestamptz;BEGIN
 IF p_action IN('accept','offer') THEN
  SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
  IF veo_reviewed_deals_enabled(a.tenant_id) THEN
   SELECT * INTO c FROM contacts WHERE id=(p_data->>'contact_id')::uuid AND veo_can_page(p_actor,page_id);
   SELECT coalesce(p.enabled_at,t.launch_at) INTO cutoff FROM veo_tenants t LEFT JOIN veo_intake_auto_policy p ON p.tenant_id=t.id AND p.enabled WHERE t.id=a.tenant_id;
   IF c.id IS NOT NULL AND coalesce(c.first_interaction_at,c.created_at)<cutoff AND NOT EXISTS(SELECT 1 FROM veo_client_claims WHERE contact_id=c.id AND user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This inquiry predates the new-client cutoff; existing contacts remain available for deal submissions' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN veo_intake_action_before_reviewed_deals(p_actor,p_action,p_data);
END $$;
REVOKE ALL ON FUNCTION veo_intake_action(uuid,text,jsonb),veo_intake_action_before_reviewed_deals(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_intake_action(uuid,text,jsonb),veo_intake_action_before_reviewed_deals(uuid,text,jsonb) TO service_role;

DO $$ DECLARE t text;fn record;BEGIN
 FOREACH t IN ARRAY ARRAY['veo_deal_review_settings','veo_deal_reviews','veo_deal_review_photos','veo_deal_tips'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',t);EXECUTE format('GRANT ALL ON %I TO service_role',t);
 END LOOP;
 FOR fn IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND(proname LIKE 'veo_deal_%' OR proname IN('veo_submit_deal_review','veo_review_deal','veo_queue_reviewed_deal','veo_enqueue_approved_deal_reviews','veo_reviewed_deal_handoff','veo_reviewed_deals_enabled','veo_scope','veo_scope_before_deal_review','veo_handoff','veo_handoff_before_reviewed_evidence')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
