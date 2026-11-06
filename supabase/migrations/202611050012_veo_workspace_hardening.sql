BEGIN;
ALTER TABLE veo_payments ADD COLUMN page_id uuid REFERENCES pages(id);
CREATE FUNCTION public.veo_payment_page() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN SELECT page_id INTO NEW.page_id FROM veo_orders WHERE id=NEW.order_id; RETURN NEW; END $$;
CREATE TRIGGER veo_payment_page BEFORE INSERT ON veo_payments FOR EACH ROW EXECUTE FUNCTION veo_payment_page();
CREATE UNIQUE INDEX ON veo_payments(page_id,lower(btrim(reference)));
CREATE TABLE public.veo_photo_objects (
 object_path text PRIMARY KEY, expires_at timestamptz NOT NULL DEFAULT(now()+interval '7 days'), deleted_at timestamptz
);
ALTER TABLE veo_photo_objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_photo_objects FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_photo_objects TO service_role;
DO $$ BEGIN
 IF to_regclass('storage.buckets') IS NOT NULL THEN
 INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 VALUES('veo-conversation-submissions','veo-conversation-submissions',false,10485760,ARRAY['image/jpeg','image/png','image/webp'])
 ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;
 END IF;
END $$;
CREATE FUNCTION public.veo_active_pages() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(p.id),'[]') FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id WHERE p.veo_enabled AND t.launch_at IS NOT NULL AND veo_can_page(t.owner_id,p.id)
$$;
CREATE FUNCTION public.veo_legacy_finance_readonly() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN
 IF EXISTS(SELECT 1 FROM veo_tenants WHERE launch_at IS NOT NULL) THEN RAISE EXCEPTION 'Retained financial history is read-only. Use the VEO verified ledger.'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 END $$;
DO $$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['contact_purchases','contact_verified_payments'] LOOP
 IF to_regclass('public.'||tbl) IS NOT NULL THEN EXECUTE format('CREATE TRIGGER veo_legacy_readonly BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION veo_legacy_finance_readonly()',tbl); END IF;
 END LOOP;
END $$;
CREATE FUNCTION public.veo_jaucian_report(p_tenant uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE result jsonb;
 BEGIN
 IF NOT EXISTS(SELECT 1 FROM veo_tenants WHERE id=p_tenant AND launch_at IS NOT NULL AND (launch_at AT TIME ZONE 'Asia/Manila')::date<=p_day) OR p_day>veo_today() THEN RAISE EXCEPTION 'Date outside launched period'; END IF;
 SELECT jsonb_build_object('tenant_id',p_tenant,'work_date',p_day,'source','VEO verified sales ledger; Telegram receipts excluded',
 'teams',coalesce((SELECT jsonb_agg(jsonb_build_object('id',tm.id,'name',tm.name,'chat_id',tm.telegram_chat_id,'thread_id',tm.telegram_thread_id,
 'workers',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.user_id,'name',u.name,'telegram_user_id',m.telegram_user_id,
 'salary',veo_salary(a.user_id,p_day),'active_tomorrow',att.active,'tomorrow_target',coalesce(dt.target,(veo_capacity(a.user_id,veo_today()+1)->>'target')::integer)))
 FROM veo_accounts a JOIN users u ON u.id=a.user_id LEFT JOIN veo_worker_mappings m ON m.user_id=a.user_id
 LEFT JOIN veo_attendance att ON att.user_id=a.user_id AND att.work_date=veo_today()+1
 LEFT JOIN veo_daily_targets dt ON dt.user_id=a.user_id AND dt.work_date=veo_today()+1
 WHERE a.active AND a.tenant_id=p_tenant AND (a.user_id=tm.manager_id OR a.parent_id=tm.manager_id)),'[]')))
 FROM veo_teams tm WHERE tm.tenant_id=p_tenant),'[]')) INTO result;
 RETURN result;
 END $$;
-- Reject chronological underpayments/overpayments even when a correction is backdated.
CREATE FUNCTION public.veo_payment_running_balance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE total bigint;
 BEGIN
 SELECT total_minor INTO total FROM veo_orders WHERE id=NEW.order_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM(SELECT sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END) OVER(ORDER BY occurred_at,created_at,id) AS balance FROM veo_payments WHERE order_id=NEW.order_id) x WHERE balance<0 OR balance>total) THEN RAISE EXCEPTION 'Payment chronology exceeds balance or refundable amount'; END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER veo_payment_running_balance AFTER INSERT ON veo_payments FOR EACH ROW EXECUTE FUNCTION veo_payment_running_balance();
DO $$ DECLARE obj record; BEGIN
 FOR obj IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'veo_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',obj.signature);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',obj.signature);
 END LOOP;
END $$;
COMMIT;
