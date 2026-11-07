BEGIN;
ALTER TABLE veo_receipts ADD COLUMN notes text NOT NULL DEFAULT '' CHECK(length(notes)<=2000);
DO $migration$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_receipt_save(uuid,jsonb)'::regprocedure);
 IF strpos(definition,'receipt_kind,order_id,object_path,photo_sha256)')=0 THEN RAISE EXCEPTION 'Expected receipt save is missing';END IF;
 definition:=replace(definition,'receipt_kind,order_id,object_path,photo_sha256)','receipt_kind,order_id,object_path,photo_sha256,notes)');
 IF strpos(definition,$old$p_data->>'photo_sha256') RETURNING id INTO rid$old$)=0 THEN RAISE EXCEPTION 'Expected receipt values are missing';END IF;
 definition:=replace(definition,$old$p_data->>'photo_sha256') RETURNING id INTO rid$old$,$new$p_data->>'photo_sha256',coalesce(p_data->>'notes','')) RETURNING id INTO rid$new$);
 EXECUTE definition;
END $migration$;

CREATE FUNCTION veo_receipt_note(p_actor uuid,p_id uuid,p_notes text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r veo_receipts;BEGIN
 PERFORM veo_receipt_access(p_actor,p_id);
 IF p_notes IS NULL OR length(p_notes)>2000 THEN RAISE EXCEPTION 'Notes must be at most 2000 characters';END IF;
 SELECT * INTO r FROM veo_receipts WHERE id=p_id FOR UPDATE;
 IF r.notes IS DISTINCT FROM p_notes THEN
  UPDATE veo_receipts SET notes=p_notes WHERE id=p_id;
  INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value) VALUES(r.tenant_id,p_actor,'receipt_notes',p_id,jsonb_build_object('notes',r.notes),jsonb_build_object('notes',p_notes));
 END IF;
 RETURN veo_receipt_facts(p_id);
END $$;

CREATE FUNCTION veo_receipt_commission(p_actor uuid,p_seller uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE a veo_accounts;snapshot jsonb;visible_totals jsonb;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF a.user_id IS NULL OR p_seller NOT IN(SELECT veo_branch(p_actor)) OR NOT EXISTS(SELECT 1 FROM veo_accounts WHERE user_id=p_seller AND tenant_id=a.tenant_id AND role IN('manager','member'))
 THEN RAISE EXCEPTION 'Commission outside your seller branch' USING ERRCODE='42501';END IF;
 IF p_day IS NULL OR p_day>veo_today() OR p_day<(SELECT (launch_at AT TIME ZONE 'Asia/Manila')::date FROM veo_tenants WHERE id=a.tenant_id)
 THEN RAISE EXCEPTION 'Choose a Philippine date from launch through today';END IF;
 snapshot:=veo_salary(p_seller,p_day);
 SELECT value->'totals' INTO visible_totals FROM jsonb_array_elements(veo_finance_days(p_actor,p_day,p_day,NULL,p_seller)->'days') WHERE value->>'user_id'=p_seller::text;
 RETURN snapshot||jsonb_build_object('totals',coalesce(visible_totals,'[]'::jsonb),'totals_scope','Current permitted Pages; qualification uses all worker Pages');
END $$;
REVOKE ALL ON FUNCTION veo_receipt_note(uuid,uuid,text),veo_receipt_commission(uuid,uuid,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_receipt_note(uuid,uuid,text),veo_receipt_commission(uuid,uuid,date) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
