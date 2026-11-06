BEGIN;
CREATE TABLE public.veo_salary_reconciliation (
 user_id uuid NOT NULL REFERENCES veo_accounts(user_id), work_date date NOT NULL,
 queued_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,work_date)
);
ALTER TABLE veo_salary_reconciliation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_salary_reconciliation FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_salary_reconciliation TO service_role;
CREATE INDEX ON veo_orders(seller_id);
CREATE INDEX ON veo_orders(contact_id);

CREATE FUNCTION public.veo_queue_salary_order(p_order uuid,p_old_seller uuid DEFAULT NULL) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN
 INSERT INTO veo_salary_reconciliation(user_id,work_date)
 SELECT DISTINCT o.seller_id,(p.occurred_at AT TIME ZONE 'Asia/Manila')::date FROM veo_orders o JOIN veo_payments p ON p.order_id=o.id WHERE o.id=p_order
 UNION SELECT DISTINCT p_old_seller,(p.occurred_at AT TIME ZONE 'Asia/Manila')::date FROM veo_payments p WHERE p.order_id=p_order AND p_old_seller IS NOT NULL
 ON CONFLICT(user_id,work_date) DO UPDATE SET queued_at=EXCLUDED.queued_at;
 END $$;
CREATE FUNCTION public.veo_salary_payment_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN PERFORM veo_queue_salary_order(NEW.order_id); RETURN NEW; END $$;
CREATE FUNCTION public.veo_salary_seller_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 BEGIN IF OLD.seller_id IS DISTINCT FROM NEW.seller_id THEN PERFORM veo_queue_salary_order(NEW.id,OLD.seller_id); END IF; RETURN NEW; END $$;
CREATE FUNCTION public.veo_salary_eligibility_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE o record;
 BEGIN
 IF OLD.pipeline_stage IS DISTINCT FROM NEW.pipeline_stage AND(OLD.pipeline_stage='converted' OR NEW.pipeline_stage='converted') THEN
 FOR o IN SELECT id FROM veo_orders WHERE contact_id=NEW.id LOOP PERFORM veo_queue_salary_order(o.id); END LOOP;
 END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER veo_salary_payment_changed AFTER INSERT ON veo_payments FOR EACH ROW EXECUTE FUNCTION veo_salary_payment_changed();
CREATE TRIGGER veo_salary_seller_changed AFTER UPDATE OF seller_id ON veo_orders FOR EACH ROW EXECUTE FUNCTION veo_salary_seller_changed();
CREATE TRIGGER veo_salary_eligibility_changed AFTER UPDATE OF pipeline_stage ON contacts FOR EACH ROW EXECUTE FUNCTION veo_salary_eligibility_changed();

-- Seed recovery work once; subsequent runs process only yesterday and changed financial dates.
INSERT INTO veo_salary_reconciliation(user_id,work_date)
 SELECT DISTINCT o.seller_id,(p.occurred_at AT TIME ZONE 'Asia/Manila')::date FROM veo_orders o JOIN veo_payments p ON p.order_id=o.id
 UNION SELECT user_id,work_date FROM veo_salary_days
 ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.veo_maintenance() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE a record; job record; item jsonb; salary jsonb; previous bigint; delta bigint;
 BEGIN
 -- A second scheduled invocation may continue event processing, but cannot duplicate adjustments.
 IF NOT pg_try_advisory_xact_lock(76110514) THEN RETURN; END IF;
 FOR a IN SELECT v.*,(t.launch_at AT TIME ZONE 'Asia/Manila')::date AS start_day FROM veo_accounts v JOIN veo_tenants t ON t.id=v.tenant_id
 WHERE t.launch_at IS NOT NULL AND v.active AND v.role IN('member','manager') ORDER BY v.user_id LOOP
 PERFORM veo_target(a.user_id,veo_today());
 IF veo_today()-1>=a.start_day THEN
 INSERT INTO veo_salary_reconciliation(user_id,work_date) VALUES(a.user_id,veo_today()-1) ON CONFLICT DO NOTHING;
 END IF;
 END LOOP;
 FOR job IN SELECT q.* FROM veo_salary_reconciliation q JOIN veo_accounts v ON v.user_id=q.user_id JOIN veo_tenants t ON t.id=v.tenant_id
 WHERE q.work_date<veo_today() AND q.work_date>=(t.launch_at AT TIME ZONE 'Asia/Manila')::date
 ORDER BY q.queued_at,q.user_id,q.work_date LIMIT 100 FOR UPDATE OF q SKIP LOCKED LOOP
 salary:=veo_salary(job.user_id,job.work_date);
 FOR item IN SELECT value FROM jsonb_array_elements(salary->'totals') UNION SELECT jsonb_build_object('currency',currency,'gross_minor',0,'commission_minor',0)
 FROM veo_salary_days d WHERE d.user_id=job.user_id AND d.work_date=job.work_date AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(salary->'totals') x WHERE x->>'currency'=d.currency) LOOP
 INSERT INTO veo_salary_days(user_id,work_date,currency,target,closed,done,rate,gross_minor,commission_minor)
 VALUES(job.user_id,job.work_date,item->>'currency',(salary->>'target')::integer,(salary->>'closed')::integer,(salary->>'done')::integer,(salary->>'rate')::integer,
 (item->>'gross_minor')::bigint,(item->>'commission_minor')::bigint) ON CONFLICT DO NOTHING;
 SELECT d.commission_minor+coalesce((SELECT sum(amount_minor) FROM veo_salary_adjustments WHERE user_id=job.user_id AND work_date=job.work_date AND currency=d.currency),0)
 INTO previous FROM veo_salary_days d WHERE d.user_id=job.user_id AND d.work_date=job.work_date AND d.currency=item->>'currency' FOR UPDATE;
 delta:=(item->>'commission_minor')::bigint-previous;
 IF delta<>0 THEN INSERT INTO veo_salary_adjustments(user_id,work_date,currency,amount_minor,reason)
 VALUES(job.user_id,job.work_date,item->>'currency',delta,'Verified financial, eligibility or attribution correction; see workspace audit and stage history'); END IF;
 END LOOP;
 DELETE FROM veo_salary_reconciliation WHERE user_id=job.user_id AND work_date=job.work_date;
 END LOOP;
 DELETE FROM veo_login_limits WHERE window_at<now()-interval '1 day';
 END $$;
REVOKE ALL ON FUNCTION veo_queue_salary_order(uuid,uuid),veo_salary_payment_changed(),veo_salary_seller_changed(),veo_salary_eligibility_changed(),veo_maintenance() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_queue_salary_order(uuid,uuid),veo_salary_payment_changed(),veo_salary_seller_changed(),veo_salary_eligibility_changed(),veo_maintenance() TO service_role;
COMMIT;
