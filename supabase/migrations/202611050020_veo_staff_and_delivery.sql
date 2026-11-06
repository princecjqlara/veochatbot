BEGIN;
ALTER TABLE veo_accounts ADD COLUMN departed_at timestamptz;
ALTER TABLE veo_accounts ADD COLUMN departure_reason text;
ALTER TABLE veo_accounts ADD COLUMN enrolled_at timestamptz NOT NULL DEFAULT now();
UPDATE veo_accounts a SET enrolled_at=coalesce((SELECT min(created_at) FROM veo_audit v WHERE v.entity_id=a.user_id AND v.action='create_account'),(SELECT min(created_at) FROM veo_daily_targets d WHERE d.user_id=a.user_id),(SELECT launch_at FROM veo_tenants WHERE id=a.tenant_id),now());
CREATE TABLE veo_order_work (
 order_id uuid PRIMARY KEY REFERENCES veo_orders(id), assignee_id uuid REFERENCES veo_accounts(user_id),
 status text NOT NULL DEFAULT 'working' CHECK(status IN('working','ready_waiting_payment','delivered')),
 completed_work_at timestamptz, delivered_at timestamptz, reason text,
 updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE veo_client_claims (
 contact_id uuid PRIMARY KEY REFERENCES contacts(id), tenant_id uuid NOT NULL REFERENCES veo_tenants(id), page_id uuid NOT NULL REFERENCES pages(id),
 user_id uuid REFERENCES veo_accounts(user_id), previous_user_id uuid REFERENCES veo_accounts(user_id),
 released_at timestamptz, claimed_at timestamptz, release_reason text
);
CREATE INDEX ON veo_client_claims(tenant_id,page_id,user_id);
ALTER TABLE veo_order_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE veo_client_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_order_work,veo_client_claims FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_order_work,veo_client_claims TO service_role;

CREATE FUNCTION veo_branch(p_actor uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE branch AS(SELECT * FROM veo_accounts WHERE user_id=p_actor AND active
 UNION ALL SELECT a.* FROM veo_accounts a JOIN branch b ON a.parent_id=b.user_id AND a.tenant_id=b.tenant_id)
 SELECT user_id FROM branch
$$;
-- A departed supervisor remains an archived hierarchy node. Their active staff
-- keep their own grants under the remaining active ancestors.
CREATE OR REPLACE FUNCTION veo_descendants(p_actor uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT user_id FROM veo_accounts WHERE user_id IN(SELECT veo_branch(p_actor)) AND active
$$;
CREATE FUNCTION veo_grant_parent(p_user uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE parents AS(SELECT a.*,1 AS depth FROM veo_accounts a WHERE user_id=(SELECT parent_id FROM veo_accounts WHERE user_id=p_user)
 UNION ALL SELECT a.*,p.depth+1 FROM veo_accounts a JOIN parents p ON a.user_id=p.parent_id WHERE p.departed_at IS NOT NULL)
 SELECT user_id FROM parents WHERE active ORDER BY depth LIMIT 1
$$;
CREATE OR REPLACE FUNCTION veo_can_page(p_actor uuid,p_page uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id
 JOIN pages p ON p.id=p_page AND p.veo_tenant_id=a.tenant_id AND p.veo_enabled
 WHERE a.user_id=p_actor AND a.active AND t.launch_at IS NOT NULL AND NOT EXISTS(
 WITH RECURSIVE parents AS(SELECT * FROM veo_accounts WHERE user_id=p_actor
 UNION ALL SELECT b.* FROM veo_accounts b JOIN parents c ON c.parent_id=b.user_id)
 SELECT 1 FROM parents b WHERE (b.departed_at IS NULL OR b.user_id=p_actor)
 AND(NOT b.active OR NOT EXISTS(SELECT 1 FROM user_pages up WHERE up.user_id=b.user_id AND up.page_id=p_page))))
$$;

CREATE FUNCTION veo_offboard(p_actor uuid,p_user uuid,p_reason text,p_source text DEFAULT 'supervisor') RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE actor veo_accounts; worker veo_accounts; result jsonb;
 BEGIN
 SELECT * INTO actor FROM veo_accounts WHERE user_id=p_actor AND active;
 SELECT * INTO worker FROM veo_accounts WHERE user_id=p_user FOR UPDATE;
 IF actor.user_id IS NULL OR worker.user_id IS NULL OR worker.tenant_id<>actor.tenant_id OR p_user=p_actor OR worker.role='owner'
 OR p_user NOT IN(SELECT veo_branch(p_actor)) OR NOT((actor.role='owner') OR(actor.role='team_leader' AND worker.role IN('manager','member')) OR(actor.role='manager' AND worker.role='member'))
 THEN RAISE EXCEPTION 'You may remove only lower-role staff in your branch' USING ERRCODE='42501'; END IF;
 IF length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'A departure reason is required'; END IF;
 IF worker.departed_at IS NOT NULL THEN RETURN jsonb_build_object('user_id',p_user,'already_removed',true); END IF;
 UPDATE veo_accounts SET active=false,departed_at=clock_timestamp(),departure_reason=p_reason WHERE user_id=p_user;
 UPDATE users SET is_active=false,password_hash=NULL WHERE id=p_user;
 DELETE FROM user_pages WHERE user_id=p_user;
 UPDATE veo_submissions SET status='blocked',last_error='Seller account removed; review client reassignment',lease_until=NULL,claim_token=NULL
 WHERE status IN('queued','processing') AND order_id IN(SELECT id FROM veo_orders WHERE seller_id=p_user);
 INSERT INTO veo_client_claims(contact_id,tenant_id,page_id,user_id,previous_user_id,released_at,release_reason)
 SELECT DISTINCT o.contact_id,o.tenant_id,o.page_id,NULL::uuid,p_user,clock_timestamp(),p_reason
 FROM veo_order_facts o LEFT JOIN veo_order_work w ON w.order_id=o.id
 WHERE (o.seller_id=p_user OR w.assignee_id=p_user) AND (o.paid_minor<o.total_minor OR coalesce(w.status,'working')<>'delivered')
 ON CONFLICT(contact_id) DO UPDATE SET user_id=NULL,previous_user_id=p_user,released_at=EXCLUDED.released_at,claimed_at=NULL,release_reason=p_reason
 WHERE veo_client_claims.user_id=p_user OR veo_client_claims.user_id IS NULL;
 UPDATE veo_client_claims SET user_id=NULL,previous_user_id=p_user,released_at=clock_timestamp(),claimed_at=NULL,release_reason=p_reason WHERE user_id=p_user;
 UPDATE veo_order_work SET assignee_id=NULL,updated_at=clock_timestamp() WHERE assignee_id=p_user;
 result:=jsonb_build_object('user_id',p_user,'active',false,'source',p_source,'released_clients',(SELECT count(*) FROM veo_client_claims WHERE previous_user_id=p_user AND user_id IS NULL));
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason)
 VALUES(actor.tenant_id,p_actor,'staff_removed',p_user,to_jsonb(worker),result,p_reason);
 RETURN result;
 END $$;

CREATE FUNCTION veo_work_action(p_actor uuid,p_action text,p_data jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE actor veo_accounts; o veo_order_facts; claim veo_client_claims; team uuid; result jsonb; desired text;
 BEGIN
 SELECT * INTO actor FROM veo_accounts WHERE user_id=p_actor AND active;
 IF actor.user_id IS NULL THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF p_action='staff_delete' THEN RETURN veo_offboard(p_actor,(p_data->>'user_id')::uuid,p_data->>'reason'); END IF;
 IF p_action='attendance_today' THEN
 IF actor.role='member' OR coalesce((p_data->>'user_id')::uuid,p_actor) NOT IN(SELECT veo_descendants(p_actor)) THEN RAISE EXCEPTION 'Supervisor access required' USING ERRCODE='42501'; END IF;
 INSERT INTO veo_attendance(user_id,work_date,active,updated_by,updated_at) VALUES(coalesce((p_data->>'user_id')::uuid,p_actor),veo_today(),(p_data->>'active')::boolean,p_actor,clock_timestamp())
 ON CONFLICT(user_id,work_date) DO UPDATE SET active=EXCLUDED.active,updated_by=p_actor,updated_at=EXCLUDED.updated_at;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(actor.tenant_id,p_actor,'attendance_today',(p_data->>'user_id')::uuid,p_data,'Current-day planning declaration; completed dates remain fixed');
 RETURN jsonb_build_object('saved',true);
 END IF;
 IF p_action='client_assignment' THEN
 SELECT * INTO claim FROM veo_client_claims WHERE contact_id=(p_data->>'contact_id')::uuid FOR UPDATE;
 SELECT page_id INTO team FROM contacts WHERE id=(p_data->>'contact_id')::uuid FOR UPDATE;
 IF team IS NULL OR NOT veo_can_page(p_actor,team) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=coalesce((p_data->>'user_id')::uuid,p_actor) AND user_id IN(SELECT veo_descendants(p_actor)) AND role IN('manager','member') AND veo_can_page(user_id,team)) THEN RAISE EXCEPTION 'Choose a selling worker on this Page'; END IF;
 IF claim.user_id IS NOT NULL AND claim.user_id<>coalesce((p_data->>'user_id')::uuid,p_actor) AND(actor.role='member' OR length(btrim(coalesce(p_data->>'reason','')))<3) THEN RAISE EXCEPTION 'A supervisor and reassignment reason are required'; END IF;
 IF claim.released_at IS NOT NULL AND claim.user_id IS NULL THEN RAISE EXCEPTION 'Use Claim released client to take over its unfinished orders'; END IF;
 INSERT INTO veo_client_claims(contact_id,tenant_id,page_id,user_id,claimed_at)
 VALUES((p_data->>'contact_id')::uuid,actor.tenant_id,team,coalesce((p_data->>'user_id')::uuid,p_actor),clock_timestamp())
 ON CONFLICT(contact_id) DO UPDATE SET user_id=EXCLUDED.user_id,claimed_at=EXCLUDED.claimed_at RETURNING to_jsonb(veo_client_claims.*) INTO result;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(actor.tenant_id,p_actor,p_action,(p_data->>'contact_id')::uuid,to_jsonb(claim),result,p_data->>'reason');
 RETURN result;
 END IF;
 IF p_action='claim_client' THEN
 IF actor.role NOT IN('member','manager') THEN RAISE EXCEPTION 'Only a selling worker may claim a client'; END IF;
 SELECT * INTO claim FROM veo_client_claims WHERE contact_id=(p_data->>'contact_id')::uuid FOR UPDATE;
 IF claim.user_id=p_actor AND claim.tenant_id=actor.tenant_id AND veo_can_page(p_actor,claim.page_id) THEN RETURN to_jsonb(claim); END IF;
 IF NOT FOUND OR claim.tenant_id<>actor.tenant_id OR NOT veo_can_page(p_actor,claim.page_id) OR claim.user_id IS NOT NULL THEN RAISE EXCEPTION 'Client is no longer available on your assigned Pages' USING ERRCODE='42501'; END IF;
 SELECT id INTO team FROM veo_teams WHERE manager_id=CASE WHEN actor.role='manager' THEN p_actor ELSE actor.parent_id END;
 IF team IS NULL THEN RAISE EXCEPTION 'A selling team is required'; END IF;
 FOR o IN SELECT f.* FROM veo_order_facts f WHERE f.contact_id=claim.contact_id AND f.seller_id=claim.previous_user_id AND f.done_at IS NULL LOOP
 UPDATE veo_orders SET seller_id=p_actor,team_id=team WHERE id=o.id;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason)
 VALUES(actor.tenant_id,p_actor,'attribution',o.id,jsonb_build_object('seller_id',o.seller_id,'team_id',o.team_id),jsonb_build_object('seller_id',p_actor,'team_id',team),'Claimed a client explicitly released after staff departure');
 END LOOP;
 INSERT INTO veo_order_work(order_id,assignee_id,updated_by)
 SELECT f.id,p_actor,p_actor FROM veo_order_facts f LEFT JOIN veo_order_work w ON w.order_id=f.id
 WHERE f.contact_id=claim.contact_id AND(w.assignee_id IS NULL OR w.assignee_id IN(p_actor,claim.previous_user_id)) AND(f.done_at IS NULL OR coalesce(w.status,'working')<>'delivered')
 ON CONFLICT(order_id) DO UPDATE SET assignee_id=p_actor,updated_by=p_actor,updated_at=clock_timestamp();
 UPDATE veo_client_claims SET user_id=p_actor,claimed_at=clock_timestamp() WHERE contact_id=claim.contact_id RETURNING to_jsonb(veo_client_claims.*) INTO result;
 ELSE
 SELECT * INTO o FROM veo_order_facts WHERE id=(p_data->>'order_id')::uuid;
 IF o.id IS NULL OR o.tenant_id<>actor.tenant_id OR NOT veo_can_page(p_actor,o.page_id) OR NOT(
 o.seller_id IN(SELECT veo_branch(p_actor)) OR EXISTS(SELECT 1 FROM veo_order_work WHERE order_id=o.id AND assignee_id IN(SELECT veo_descendants(p_actor))))
 THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 desired:=p_data->>'status';
 IF desired NOT IN('working','ready_waiting_payment','delivered') OR coalesce(length(btrim(p_data->>'reason')),0)<3 THEN RAISE EXCEPTION 'Choose a work status and add an explanation'; END IF;
 IF desired='ready_waiting_payment' AND(o.paid_minor>=o.total_minor OR p_data->'work_complete'<>'true'::jsonb OR p_data->>'work_complete' IS NULL) THEN RAISE EXCEPTION 'Confirm the project is finished and a client balance remains'; END IF;
 INSERT INTO veo_order_work(order_id,assignee_id,status,completed_work_at,delivered_at,reason,updated_by)
 VALUES(o.id,o.seller_id,desired,CASE WHEN desired<>'working' THEN clock_timestamp() END,CASE WHEN desired='delivered' THEN clock_timestamp() END,p_data->>'reason',p_actor)
 ON CONFLICT(order_id) DO UPDATE SET status=EXCLUDED.status,completed_work_at=CASE WHEN EXCLUDED.status='working' THEN NULL ELSE coalesce(veo_order_work.completed_work_at,EXCLUDED.completed_work_at) END,delivered_at=CASE WHEN EXCLUDED.status='delivered' THEN coalesce(veo_order_work.delivered_at,EXCLUDED.delivered_at) END,reason=EXCLUDED.reason,updated_by=p_actor,updated_at=clock_timestamp()
 RETURNING to_jsonb(veo_order_work.*) INTO result;
 END IF;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(actor.tenant_id,p_actor,p_action,coalesce((p_data->>'order_id')::uuid,(p_data->>'contact_id')::uuid),result,p_data->>'reason');
 RETURN result;
 END $$;

CREATE FUNCTION veo_record_payment(p_actor uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE actor veo_accounts; o veo_orders; pay veo_payments; n bigint; launched timestamptz;
 BEGIN
 SELECT * INTO actor FROM veo_accounts WHERE user_id=p_actor AND active;
 SELECT * INTO o FROM veo_orders WHERE id=(p_data->>'order_id')::uuid FOR UPDATE;
 IF actor.user_id IS NULL OR o.id IS NULL OR o.tenant_id<>actor.tenant_id OR NOT veo_can_page(p_actor,o.page_id) OR o.seller_id NOT IN(SELECT veo_branch(p_actor)) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=o.seller_id AND active) AND p_data->>'kind'<>'refund' THEN RAISE EXCEPTION 'Claim or reassign this departed seller''s unfinished client first'; END IF;
 IF p_data->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Verify the payment against payment records'; END IF;
 IF p_data->>'kind' NOT IN('deposit','balance','full','refund') THEN RAISE EXCEPTION 'Invalid payment kind'; END IF;
 SELECT * INTO pay FROM veo_payments WHERE request_id=(p_data->>'request_id')::uuid;
 IF FOUND THEN
 IF pay.order_id<>o.id OR pay.kind<>p_data->>'kind' OR pay.amount_minor<>(p_data->>'amount_minor')::bigint OR pay.reference<>btrim(p_data->>'reference') OR pay.occurred_at<>(p_data->>'occurred_at')::timestamptz THEN RAISE EXCEPTION 'Request ID conflict'; END IF;
 RETURN to_jsonb(pay); END IF;
 SELECT launch_at INTO launched FROM veo_tenants WHERE id=actor.tenant_id;
 IF (p_data->>'occurred_at')::timestamptz<launched OR (p_data->>'occurred_at')::timestamptz>now() THEN RAISE EXCEPTION 'Payment date must be within the launched period'; END IF;
 SELECT coalesce(sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END),0) INTO n FROM veo_payments WHERE order_id=o.id;
 IF(p_data->>'amount_minor')::bigint<=0 OR(p_data->>'kind'='refund' AND(p_data->>'amount_minor')::bigint>n) OR(p_data->>'kind'<>'refund' AND n+(p_data->>'amount_minor')::bigint>o.total_minor) THEN RAISE EXCEPTION 'Payment exceeds balance or refundable amount'; END IF;
 IF p_data->>'kind'='refund' AND(actor.role='member' OR length(btrim(coalesce(p_data->>'reason','')))<3) THEN RAISE EXCEPTION 'A supervisor and refund reason are required'; END IF;
 INSERT INTO veo_payments(request_id,order_id,kind,amount_minor,reference,occurred_at,verified_by) VALUES((p_data->>'request_id')::uuid,o.id,p_data->>'kind',(p_data->>'amount_minor')::bigint,btrim(p_data->>'reference'),(p_data->>'occurred_at')::timestamptz,p_actor) RETURNING * INTO pay;
 PERFORM veo_target(o.seller_id,(pay.occurred_at AT TIME ZONE 'Asia/Manila')::date);
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,after_value,reason) VALUES(actor.tenant_id,p_actor,'payment',o.id,to_jsonb(pay),p_data->>'reason');
 RETURN to_jsonb(pay);
 END $$;
ALTER FUNCTION veo_action(uuid,text,jsonb) RENAME TO veo_action_core;
CREATE FUNCTION veo_reassign_order(p_actor uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE actor veo_accounts; o veo_orders; seller uuid; team uuid; result jsonb;
 BEGIN
 SELECT * INTO actor FROM veo_accounts WHERE user_id=p_actor AND active;
 SELECT * INTO o FROM veo_orders WHERE id=(p_data->>'order_id')::uuid FOR UPDATE;
 seller:=(p_data->>'seller_id')::uuid;
 IF actor.user_id IS NULL OR actor.role='member' OR o.tenant_id IS DISTINCT FROM actor.tenant_id OR NOT veo_can_page(p_actor,o.page_id) OR o.seller_id NOT IN(SELECT veo_branch(p_actor)) OR seller NOT IN(SELECT veo_descendants(p_actor)) OR NOT veo_can_page(seller,o.page_id) OR length(btrim(coalesce(p_data->>'reason','')))<3 THEN RAISE EXCEPTION 'Supervisor, permitted order/seller and reason required' USING ERRCODE='42501'; END IF;
 SELECT t.id INTO team FROM veo_teams t JOIN veo_accounts a ON a.user_id=seller WHERE a.role IN('member','manager') AND t.manager_id=CASE WHEN a.role='manager' THEN seller ELSE a.parent_id END;
 IF team IS NULL THEN RAISE EXCEPTION 'Choose a selling worker'; END IF;
 UPDATE veo_orders SET seller_id=seller,team_id=team WHERE id=o.id RETURNING to_jsonb(veo_orders.*) INTO result;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason) VALUES(actor.tenant_id,p_actor,'attribution',o.id,to_jsonb(o),result,p_data->>'reason');
 RETURN result; END $$;
DO $migration$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('veo_action_core(uuid,text,jsonb)'::regprocedure);
 definition:=replace(definition,'veo_can_page((SELECT parent_id FROM veo_accounts WHERE user_id=u),p)','veo_can_page(veo_grant_parent(u),p)'); EXECUTE definition;
END $migration$;
CREATE FUNCTION veo_action(p_actor uuid,p_action text,p_data jsonb DEFAULT '{}') RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE result jsonb; pg uuid; assigned uuid;
 BEGIN
 IF p_action IN('staff_delete','claim_client','fulfillment','client_assignment','attendance_today') THEN RETURN veo_work_action(p_actor,p_action,p_data); END IF;
 IF p_action='attribution' THEN RETURN veo_reassign_order(p_actor,p_data); END IF;
 IF p_action='order' THEN
 SELECT page_id INTO pg FROM contacts WHERE id=(p_data->>'contact_id')::uuid FOR UPDATE;
 SELECT user_id INTO assigned FROM veo_client_claims WHERE contact_id=(p_data->>'contact_id')::uuid;
 IF FOUND AND(assigned IS NULL OR assigned IS DISTINCT FROM (p_data->>'seller_id')::uuid) THEN RAISE EXCEPTION 'Claim this released client before creating a new order'; END IF;
 END IF;
 result:=CASE WHEN p_action='payment' THEN veo_record_payment(p_actor,p_data) ELSE veo_action_core(p_actor,p_action,p_data) END;
 IF p_action='payment' AND p_data->'confirm_converted'='true'::jsonb THEN
 SELECT page_id INTO pg FROM veo_orders WHERE id=(p_data->>'order_id')::uuid;
 IF NOT veo_can_page(p_actor,pg) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 UPDATE contacts SET pipeline_stage='converted' WHERE id=(SELECT contact_id FROM veo_orders WHERE id=(p_data->>'order_id')::uuid);
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,reason) SELECT tenant_id,p_actor,'verified_payment_conversion',contact_id,'Human verified payment and confirmed Converted lead' FROM veo_orders WHERE id=(p_data->>'order_id')::uuid;
 END IF;
 RETURN result;
 END $$;

-- Keep teams with active staff visible after their manager leaves.
DO $migration$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('veo_scope(uuid)'::regprocedure);
 definition:=replace(definition,'SELECT jsonb_agg(d) FROM veo_descendants(p_actor) d','SELECT jsonb_agg(d) FROM veo_branch(p_actor) d');
 EXECUTE definition;
 definition:=pg_get_functiondef('veo_dashboard(uuid,date)'::regprocedure);
 definition:=replace(definition,'veo_descendants(p_actor)','veo_branch(p_actor)');
 definition:=replace(definition,'''role'',a.role,''parent_id'',a.parent_id,','''role'',a.role,''active'',a.active,''departed_at'',a.departed_at,''parent_id'',a.parent_id,');
 definition:=replace(definition,'WHERE a.user_id IN(SELECT veo_branch(p_actor)) AND a.role IN(''member'',''manager'')','WHERE a.active AND a.user_id IN(SELECT veo_branch(p_actor)) AND a.role IN(''member'',''manager'')');
 EXECUTE definition;
 definition:=pg_get_functiondef('veo_team_capacity(uuid,date)'::regprocedure);
 definition:=replace(definition,'t.manager_id IN(SELECT veo_descendants(p_actor))','t.manager_id IN(SELECT veo_branch(p_actor))');
 EXECUTE definition;
END $migration$;
DO $$ DECLARE fn record; BEGIN
 FOR fn IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('veo_branch','veo_grant_parent','veo_offboard','veo_work_action','veo_action','veo_action_core','veo_descendants','veo_can_page','veo_record_payment','veo_reassign_order') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn.signature);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn.signature);
 END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
