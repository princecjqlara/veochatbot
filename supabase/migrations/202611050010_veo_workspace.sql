BEGIN;

-- Preparation only. veo_launch binds the existing owner and the explicit VEO page list.
CREATE TABLE public.veo_tenants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL UNIQUE REFERENCES users(id),
 name text NOT NULL DEFAULT 'VEO', launch_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.veo_accounts (
 user_id uuid PRIMARY KEY REFERENCES users(id), tenant_id uuid NOT NULL REFERENCES veo_tenants(id),
 role text NOT NULL CHECK(role IN ('owner','team_leader','manager','member')),
 parent_id uuid REFERENCES veo_accounts(user_id), active boolean NOT NULL DEFAULT true,
 CHECK((role='owner')=(parent_id IS NULL))
);
ALTER TABLE pages ADD COLUMN veo_tenant_id uuid REFERENCES veo_tenants(id);
ALTER TABLE pages ADD COLUMN veo_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE public.veo_teams (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES veo_tenants(id),
 manager_id uuid NOT NULL UNIQUE REFERENCES veo_accounts(user_id), name text NOT NULL,
 telegram_chat_id bigint, telegram_thread_id bigint,
 CHECK(telegram_chat_id IS NULL OR telegram_chat_id<0)
);
CREATE TABLE public.veo_worker_mappings (
 user_id uuid PRIMARY KEY REFERENCES veo_accounts(user_id), telegram_user_id bigint NOT NULL UNIQUE CHECK(telegram_user_id>0)
);
CREATE TABLE public.veo_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE,
 tenant_id uuid NOT NULL REFERENCES veo_tenants(id), team_id uuid NOT NULL REFERENCES veo_teams(id),
 page_id uuid NOT NULL REFERENCES pages(id), contact_id uuid NOT NULL REFERENCES contacts(id),
 seller_id uuid NOT NULL REFERENCES veo_accounts(user_id), description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 500),
 total_minor bigint NOT NULL CHECK(total_minor>0 AND total_minor<=9000000000000), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.veo_payments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL UNIQUE,
 order_id uuid NOT NULL REFERENCES veo_orders(id), kind text NOT NULL CHECK(kind IN ('deposit','balance','full','refund')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0), reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 3 AND 160),
 occurred_at timestamptz NOT NULL, verified_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,reference)
);
CREATE INDEX ON veo_payments(order_id,occurred_at,created_at,id);
CREATE INDEX ON veo_orders(tenant_id,seller_id,page_id);
CREATE TABLE public.veo_daily_targets (
 user_id uuid NOT NULL REFERENCES veo_accounts(user_id), work_date date NOT NULL, target integer NOT NULL CHECK(target>=1),
 basis jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,work_date)
);
CREATE TABLE public.veo_attendance (
 user_id uuid NOT NULL REFERENCES veo_accounts(user_id), work_date date NOT NULL, active boolean NOT NULL,
 updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,work_date)
);
CREATE TABLE public.veo_salary_days (
 user_id uuid NOT NULL REFERENCES veo_accounts(user_id), work_date date NOT NULL, currency text NOT NULL,
 target integer NOT NULL, closed integer NOT NULL, done integer NOT NULL, rate integer NOT NULL CHECK(rate IN (35,40)),
 gross_minor bigint NOT NULL, commission_minor bigint NOT NULL, finalized_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,work_date,currency)
);
CREATE TABLE public.veo_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES veo_tenants(id),
 actor_id uuid REFERENCES users(id), action text NOT NULL, entity_id uuid, before_value jsonb, after_value jsonb,
 reason text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.veo_salary_adjustments (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL REFERENCES veo_accounts(user_id),
 work_date date NOT NULL, currency text NOT NULL, amount_minor bigint NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.veo_submissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES veo_orders(id),
 submitted_by uuid NOT NULL REFERENCES users(id), object_path text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL DEFAULT(now()+interval '7 days'),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','delivered','expired','blocked')),
 attempt_count integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, claim_token uuid, last_error text, delivered_at timestamptz, deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON veo_submissions(order_id) WHERE status IN ('queued','processing','delivered');
CREATE TABLE public.veo_event_inbox (
 event_key text PRIMARY KEY, page_id uuid NOT NULL REFERENCES pages(id), occurred_at timestamptz NOT NULL,
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','done')),
 attempts integer NOT NULL DEFAULT 0, lease_until timestamptz, last_error text,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.veo_contact_details (
 contact_id uuid PRIMARY KEY REFERENCES contacts(id), fields jsonb NOT NULL DEFAULT '{}',
 updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.veo_archive_records (
 tenant_id uuid NOT NULL REFERENCES veo_tenants(id), source_table text NOT NULL, record_key text NOT NULL,
 record jsonb NOT NULL, archived_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,source_table,record_key)
);
CREATE TABLE public.veo_login_limits (key text PRIMARY KEY, window_at timestamptz NOT NULL, attempts integer NOT NULL);

CREATE FUNCTION public.veo_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Manila')::date $$;
CREATE FUNCTION public.veo_descendants(p_actor uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE branch AS (
 SELECT a.* FROM veo_accounts a WHERE a.user_id=p_actor AND a.active
 UNION ALL SELECT a.* FROM veo_accounts a JOIN branch b ON a.parent_id=b.user_id AND a.tenant_id=b.tenant_id WHERE a.active
 ) SELECT user_id FROM branch
$$;
CREATE FUNCTION public.veo_can_page(p_actor uuid,p_page uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id
 JOIN pages p ON p.id=p_page AND p.veo_tenant_id=a.tenant_id AND p.veo_enabled
 WHERE a.user_id=p_actor AND a.active AND t.launch_at IS NOT NULL
 AND NOT EXISTS(
 WITH RECURSIVE parents AS (
 SELECT * FROM veo_accounts WHERE user_id=p_actor
 UNION ALL SELECT b.* FROM veo_accounts b JOIN parents c ON c.parent_id=b.user_id
 ) SELECT 1 FROM parents b WHERE NOT b.active OR NOT EXISTS(SELECT 1 FROM user_pages up WHERE up.user_id=b.user_id AND up.page_id=p_page)))
$$;
CREATE FUNCTION public.veo_scope(p_actor uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('user_id',a.user_id,'tenant_id',a.tenant_id,'role',a.role,'launch_at',t.launch_at,
 'page_ids',coalesce((SELECT jsonb_agg(p.id) FROM pages p WHERE veo_can_page(p_actor,p.id)),'[]'),
 'worker_ids',coalesce((SELECT jsonb_agg(d) FROM veo_descendants(p_actor) d),'[]'))
 FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id WHERE a.user_id=p_actor AND a.active
$$;
CREATE FUNCTION public.veo_login_attempt(p_key text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE n integer;
 BEGIN
 INSERT INTO veo_login_limits VALUES(p_key,now(),1) ON CONFLICT(key) DO UPDATE SET
 attempts=CASE WHEN veo_login_limits.window_at<now()-interval '15 minutes' THEN 1 ELSE veo_login_limits.attempts+1 END,
 window_at=CASE WHEN veo_login_limits.window_at<now()-interval '15 minutes' THEN now() ELSE veo_login_limits.window_at END RETURNING attempts INTO n;
 RETURN n<=10;
 END $$;

-- First payment and first full settlement are unique milestones, regardless of retries or later refunds.
CREATE VIEW public.veo_order_facts AS
 SELECT o.*,coalesce(p.paid_minor,0)::bigint AS paid_minor,p.closed_at,p.done_at,
 c.pipeline_stage='converted' AS converted,
 CASE WHEN c.pipeline_stage='converted' THEN (p.closed_at AT TIME ZONE 'Asia/Manila')::date END AS closed_date,
 CASE WHEN c.pipeline_stage='converted' THEN (p.done_at AT TIME ZONE 'Asia/Manila')::date END AS done_date
 FROM veo_orders o JOIN contacts c ON c.id=o.contact_id AND c.page_id=o.page_id
 LEFT JOIN LATERAL (
 SELECT sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END) AS paid_minor,
 min(occurred_at) FILTER(WHERE kind<>'refund') AS closed_at,
 min(occurred_at) FILTER(WHERE running>=o.total_minor) AS done_at
 FROM (SELECT p.*,sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END)
 OVER(ORDER BY occurred_at,created_at,id) AS running FROM veo_payments p WHERE p.order_id=o.id) q
 ) p ON true;

CREATE FUNCTION public.veo_capacity(p_user uuid,p_day date) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH days AS (SELECT done_date,count(*)::integer AS n FROM veo_order_facts
 WHERE seller_id=p_user AND done_date>=p_day-14 AND done_date<least(p_day,veo_today()) GROUP BY done_date),
 best AS (SELECT * FROM days ORDER BY n DESC,done_date DESC LIMIT 3)
 SELECT jsonb_build_object('target',CASE WHEN count(*)<3 THEN 1 ELSE greatest(1,floor(avg(n)*0.8)::integer) END,
 'eligible_days',count(*),'best_days',coalesce(jsonb_agg(to_jsonb(best)),'[]'),'window_end',least(p_day,veo_today())-1) FROM best
$$;
CREATE FUNCTION public.veo_target(p_user uuid,p_day date) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE basis jsonb; result integer;
 BEGIN
 SELECT target INTO result FROM veo_daily_targets WHERE user_id=p_user AND work_date=p_day;
 IF FOUND THEN RETURN result; END IF;
 basis:=veo_capacity(p_user,p_day);
 INSERT INTO veo_daily_targets VALUES(p_user,p_day,(basis->>'target')::integer,basis,now()) ON CONFLICT DO NOTHING;
 SELECT target INTO result FROM veo_daily_targets WHERE user_id=p_user AND work_date=p_day;
 RETURN result;
 END $$;
CREATE FUNCTION public.veo_salary(p_user uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE cd integer; dd integer; target integer; rate integer; totals jsonb;
 BEGIN
 target:=veo_target(p_user,p_day);
 SELECT count(*) FILTER(WHERE closed_date=p_day),count(*) FILTER(WHERE done_date=p_day) INTO cd,dd
 FROM veo_order_facts WHERE seller_id=p_user;
 rate:=CASE WHEN cd>=target AND dd>=target THEN 40 ELSE 35 END;
 SELECT coalesce(jsonb_agg(jsonb_build_object('currency',currency,'gross_minor',gross,'commission_minor',floor(gross*rate::numeric/100))), '[]') INTO totals
 FROM (SELECT currency,sum(amount)::bigint AS gross FROM (
 SELECT currency,total_minor AS amount FROM veo_order_facts WHERE seller_id=p_user AND done_date=p_day
 UNION ALL
 SELECT o.currency,-p.amount_minor FROM veo_payments p JOIN veo_order_facts o ON o.id=p.order_id
 WHERE o.seller_id=p_user AND o.done_date=p_day AND p.kind='refund'
 ) x GROUP BY currency) y;
 RETURN jsonb_build_object('user_id',p_user,'work_date',p_day,'target',target,'closed',cd,'done',dd,'rate',rate,'totals',totals,'provisional',p_day>=veo_today());
 END $$;

CREATE FUNCTION public.veo_action(p_actor uuid,p_action text,p_data jsonb DEFAULT '{}') RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE a veo_accounts; parent veo_accounts; t veo_tenants; o veo_orders; pay veo_payments;
 result jsonb; u uuid; pg uuid; cid uuid; team uuid; ids uuid[]; n bigint; day date; old jsonb; desired text;
 BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;
 IF NOT FOUND THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO t FROM veo_tenants WHERE id=a.tenant_id;
 IF t.launch_at IS NULL THEN RAISE EXCEPTION 'Workspace has not launched'; END IF;
 IF p_action='create_account' THEN
 desired:=p_data->>'role'; u:=(p_data->>'user_id')::uuid;
 SELECT * INTO parent FROM veo_accounts WHERE user_id=(p_data->>'parent_id')::uuid AND tenant_id=a.tenant_id AND active;
 IF NOT FOUND OR parent.user_id NOT IN(SELECT veo_descendants(p_actor)) OR
 NOT ((parent.role='owner' AND desired IN ('team_leader','manager')) OR (parent.role='team_leader' AND desired='manager') OR(parent.role='manager' AND desired='member')) THEN RAISE EXCEPTION 'Invalid account hierarchy' USING ERRCODE='42501'; END IF;
 ids:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_data->'page_ids'));
 IF coalesce(cardinality(ids),0)=0 OR EXISTS(SELECT 1 FROM unnest(ids) p WHERE NOT veo_can_page(p_actor,p) OR NOT veo_can_page(parent.user_id,p)) THEN RAISE EXCEPTION 'Assign at least one permitted page' USING ERRCODE='42501'; END IF;
 IF length(p_data->>'password_hash')<30 OR length(btrim(p_data->>'email'))=0 THEN RAISE EXCEPTION 'Email and hashed password required'; END IF;
 IF EXISTS(SELECT 1 FROM users old JOIN veo_accounts current ON current.user_id=old.id WHERE lower(old.email)=lower(btrim(p_data->>'email'))) THEN RAISE EXCEPTION 'An account already exists for this email' USING ERRCODE='23505'; END IF;
 INSERT INTO users(id,email,name,password_hash,role,is_active) VALUES(u,lower(btrim(p_data->>'email')),p_data->>'name',p_data->>'password_hash',desired,true)
 ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,is_active=true RETURNING id INTO u;
 INSERT INTO veo_accounts VALUES(u,a.tenant_id,desired,parent.user_id,true);
 INSERT INTO user_pages(user_id,page_id) SELECT u,unnest(ids);
 IF desired='manager' THEN INSERT INTO veo_teams(tenant_id,manager_id,name) VALUES(a.tenant_id,u,p_data->>'name'); END IF;
 PERFORM veo_target(u,veo_today());
 result:=jsonb_build_object('id',u);
 ELSIF p_action='password' THEN
 u:=coalesce((p_data->>'user_id')::uuid,p_actor);
 IF u NOT IN(SELECT veo_descendants(p_actor)) OR (a.role='member' AND u<>p_actor) OR length(coalesce(p_data->>'password_hash',''))<30 THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 UPDATE users SET password_hash=p_data->>'password_hash' WHERE id=u;
 result:=jsonb_build_object('user_id',u,'password_changed',true);
 ELSIF p_action='assign_pages' THEN
 u:=(p_data->>'user_id')::uuid;
 IF a.role='member' OR u=p_actor OR u NOT IN(SELECT veo_descendants(p_actor)) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 ids:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_data->'page_ids'));
 IF EXISTS(SELECT 1 FROM unnest(ids) p WHERE NOT veo_can_page(p_actor,p)) THEN RAISE EXCEPTION 'Page outside your scope' USING ERRCODE='42501'; END IF;
 SELECT jsonb_agg(page_id) INTO old FROM user_pages WHERE user_id=u;
 DELETE FROM user_pages WHERE user_id IN(SELECT veo_descendants(u)) AND page_id NOT IN(SELECT unnest(ids));
 INSERT INTO user_pages(user_id,page_id) SELECT u,unnest(ids) ON CONFLICT(user_id,page_id) DO NOTHING;
 result:=to_jsonb(ids);
 ELSIF p_action='order' THEN
 pg:=(p_data->>'page_id')::uuid; cid:=(p_data->>'contact_id')::uuid; u:=coalesce((p_data->>'seller_id')::uuid,p_actor);
 IF NOT veo_can_page(p_actor,pg) OR NOT veo_can_page(u,pg) OR u NOT IN(SELECT veo_descendants(p_actor)) OR
 NOT EXISTS(SELECT 1 FROM contacts WHERE id=cid AND page_id=pg) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 SELECT tm.id INTO team FROM veo_teams tm JOIN veo_accounts w ON w.user_id=u WHERE tm.manager_id=CASE WHEN w.role='manager' THEN w.user_id ELSE w.parent_id END;
 IF team IS NULL THEN RAISE EXCEPTION 'Choose a selling manager or member'; END IF;
 INSERT INTO veo_orders(request_id,tenant_id,team_id,page_id,contact_id,seller_id,description,total_minor,currency,created_by)
 VALUES((p_data->>'request_id')::uuid,a.tenant_id,team,pg,cid,u,p_data->>'description',(p_data->>'total_minor')::bigint,upper(p_data->>'currency'),p_actor)
 ON CONFLICT(request_id) DO NOTHING RETURNING * INTO o;
 IF NOT FOUND THEN SELECT * INTO o FROM veo_orders WHERE request_id=(p_data->>'request_id')::uuid AND created_by=p_actor AND page_id=pg AND contact_id=cid; END IF;
 IF o.id IS NULL OR o.seller_id<>u OR o.total_minor<>(p_data->>'total_minor')::bigint OR o.currency<>upper(p_data->>'currency') OR o.description<>p_data->>'description' THEN RAISE EXCEPTION 'Request ID conflict'; END IF;
 result:=to_jsonb(o);
 ELSIF p_action IN ('payment','attribution','submission') THEN
 SELECT * INTO o FROM veo_orders WHERE id=(p_data->>'order_id')::uuid FOR UPDATE;
 IF NOT FOUND OR o.tenant_id<>a.tenant_id OR NOT veo_can_page(p_actor,o.page_id) OR o.seller_id NOT IN(SELECT veo_descendants(p_actor)) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 old:=to_jsonb(o);
 IF p_action='payment' THEN
 IF p_data->'confirmed'<>'true'::jsonb OR p_data->>'confirmed' IS NULL THEN RAISE EXCEPTION 'Verify the payment against payment records'; END IF;
 SELECT * INTO pay FROM veo_payments WHERE request_id=(p_data->>'request_id')::uuid;
 IF FOUND THEN
 IF pay.order_id<>o.id OR pay.kind<>p_data->>'kind' OR pay.amount_minor<>(p_data->>'amount_minor')::bigint OR pay.reference<>p_data->>'reference' THEN RAISE EXCEPTION 'Request ID conflict'; END IF;
 RETURN to_jsonb(pay);
 END IF;
 IF (p_data->>'occurred_at')::timestamptz<t.launch_at OR (p_data->>'occurred_at')::timestamptz>now() THEN RAISE EXCEPTION 'Payment date must be within the launched period'; END IF;
 SELECT coalesce(sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END),0) INTO n FROM veo_payments WHERE order_id=o.id;
 IF (p_data->>'amount_minor')::bigint<=0 OR (p_data->>'kind'='refund' AND (p_data->>'amount_minor')::bigint>n) OR
 (p_data->>'kind'<>'refund' AND n+(p_data->>'amount_minor')::bigint>o.total_minor) THEN RAISE EXCEPTION 'Payment exceeds balance or refundable amount'; END IF;
 IF p_data->>'kind'='refund' AND (a.role='member' OR coalesce(length(btrim(p_data->>'reason')),0)<3) THEN RAISE EXCEPTION 'A supervisor and refund reason are required'; END IF;
 INSERT INTO veo_payments(request_id,order_id,kind,amount_minor,reference,occurred_at,verified_by)
 VALUES((p_data->>'request_id')::uuid,o.id,p_data->>'kind',(p_data->>'amount_minor')::bigint,btrim(p_data->>'reference'),(p_data->>'occurred_at')::timestamptz,p_actor) RETURNING * INTO pay;
 PERFORM veo_target(o.seller_id,(pay.occurred_at AT TIME ZONE 'Asia/Manila')::date);
 result:=to_jsonb(pay);
 ELSIF p_action='attribution' THEN
 u:=(p_data->>'seller_id')::uuid;
 IF a.role='member' OR u NOT IN(SELECT veo_descendants(p_actor)) OR NOT veo_can_page(u,o.page_id) OR coalesce(length(btrim(p_data->>'reason')),0)<3 THEN RAISE EXCEPTION 'Supervisor, permitted seller and reason required'; END IF;
 SELECT tm.id INTO team FROM veo_teams tm JOIN veo_accounts w ON w.user_id=u WHERE tm.manager_id=CASE WHEN w.role='manager' THEN w.user_id ELSE w.parent_id END;
 IF team IS NULL THEN RAISE EXCEPTION 'Choose a selling worker'; END IF;
 UPDATE veo_orders SET seller_id=u,team_id=team WHERE id=o.id RETURNING to_jsonb(veo_orders.*) INTO result;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM veo_order_facts WHERE id=o.id AND converted AND paid_minor=total_minor AND done_at IS NOT NULL) THEN RAISE EXCEPTION 'Converted contact and full verified payment required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM veo_teams WHERE id=o.team_id AND telegram_chat_id IS NOT NULL) OR NOT EXISTS(SELECT 1 FROM veo_worker_mappings WHERE user_id=o.seller_id) THEN RAISE EXCEPTION 'Telegram team and worker mapping required'; END IF;
 IF p_data->>'object_path' NOT LIKE a.tenant_id::text||'/'||p_actor::text||'/%' THEN RAISE EXCEPTION 'Invalid photo location'; END IF;
 INSERT INTO veo_submissions(order_id,submitted_by,object_path) VALUES(o.id,p_actor,p_data->>'object_path') RETURNING to_jsonb(veo_submissions.*) INTO result;
 END IF;
 ELSIF p_action='attendance' THEN
 u:=coalesce((p_data->>'user_id')::uuid,p_actor); day:=(p_data->>'work_date')::date;
 IF u NOT IN(SELECT veo_descendants(p_actor)) OR day<>veo_today()+1 THEN RAISE EXCEPTION 'Only tomorrow attendance within your branch can change'; END IF;
 INSERT INTO veo_attendance VALUES(u,day,(p_data->>'active')::boolean,p_actor,now()) ON CONFLICT(user_id,work_date) DO UPDATE SET active=EXCLUDED.active,updated_by=p_actor,updated_at=now();
 result:=jsonb_build_object('saved',true);
 ELSIF p_action='contact' THEN
 cid:=(p_data->>'contact_id')::uuid;
 SELECT page_id INTO pg FROM contacts WHERE id=cid;
 IF NOT veo_can_page(p_actor,pg) OR jsonb_typeof(p_data->'fields')<>'object' OR length((p_data->'fields')::text)>30000 THEN RAISE EXCEPTION 'Invalid contact fields'; END IF;
 SELECT to_jsonb(d.*) INTO old FROM veo_contact_details d WHERE contact_id=cid;
 INSERT INTO veo_contact_details VALUES(cid,p_data->'fields',p_actor,now()) ON CONFLICT(contact_id) DO UPDATE SET fields=veo_contact_details.fields||EXCLUDED.fields,updated_by=p_actor,updated_at=now() RETURNING to_jsonb(veo_contact_details.*) INTO result;
 IF p_data ? 'name' THEN UPDATE contacts SET name=nullif(btrim(p_data->>'name'),'') WHERE id=cid; END IF;
 ELSIF p_action='mapping' THEN
 IF a.role<>'owner' THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 IF p_data ? 'team_id' THEN
 team:=(p_data->>'team_id')::uuid;
 UPDATE veo_teams SET telegram_chat_id=(p_data->>'chat_id')::bigint,telegram_thread_id=(p_data->>'thread_id')::bigint WHERE id=team AND tenant_id=a.tenant_id RETURNING to_jsonb(veo_teams.*) INTO result;
 ELSE
 u:=(p_data->>'user_id')::uuid;
 IF u NOT IN(SELECT veo_descendants(p_actor)) THEN RAISE EXCEPTION 'Forbidden'; END IF;
 INSERT INTO veo_worker_mappings VALUES(u,(p_data->>'telegram_user_id')::bigint) ON CONFLICT(user_id) DO UPDATE SET telegram_user_id=EXCLUDED.telegram_user_id;
 result:=jsonb_build_object('saved',true);
 END IF;
 ELSE RAISE EXCEPTION 'Unknown workspace action';
 END IF;
 INSERT INTO veo_audit(tenant_id,actor_id,action,entity_id,before_value,after_value,reason)
 VALUES(a.tenant_id,p_actor,p_action,coalesce(o.id,u,cid,team),old,result - 'password_hash',p_data->>'reason');
 RETURN result;
 END $$;

CREATE FUNCTION public.veo_dashboard(p_actor uuid,p_day date DEFAULT public.veo_today()) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE scope jsonb; result jsonb;
 BEGIN
 scope:=veo_scope(p_actor);
 IF scope IS NULL OR scope->>'launch_at' IS NULL THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('scope',scope,'date',p_day,
 'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.user_id,'name',u.name,'email',u.email,'role',a.role,'parent_id',a.parent_id,
 'page_ids',(SELECT coalesce(jsonb_agg(page_id),'[]') FROM user_pages WHERE user_id=a.user_id))) FROM veo_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id IN(SELECT veo_descendants(p_actor))),'[]'),
 'teams',coalesce((SELECT jsonb_agg(to_jsonb(tm.*)) FROM veo_teams tm WHERE tm.tenant_id=(scope->>'tenant_id')::uuid AND tm.manager_id IN(SELECT veo_descendants(p_actor))),'[]'),
 'orders',coalesce((SELECT jsonb_agg(to_jsonb(o.*)||jsonb_build_object('contact_name',c.name,'seller_name',u.name)) FROM
 (SELECT * FROM veo_order_facts WHERE seller_id IN(SELECT veo_descendants(p_actor)) AND veo_can_page(p_actor,page_id) ORDER BY created_at DESC LIMIT 500) o JOIN contacts c ON c.id=o.contact_id JOIN users u ON u.id=o.seller_id),'[]'),
 'salary',coalesce((SELECT jsonb_agg(veo_salary(a.user_id,p_day)) FROM veo_accounts a WHERE a.user_id IN(SELECT veo_descendants(p_actor)) AND a.role IN ('member','manager')),'[]'),
 'tomorrow',coalesce((SELECT jsonb_agg(jsonb_build_object('user_id',a.user_id,'active',att.active,'target',coalesce(t.target,(veo_capacity(a.user_id,veo_today()+1)->>'target')::integer))) FROM veo_accounts a
 LEFT JOIN veo_attendance att ON att.user_id=a.user_id AND att.work_date=veo_today()+1
 LEFT JOIN veo_daily_targets t ON t.user_id=a.user_id AND t.work_date=veo_today()+1
 WHERE a.user_id IN(SELECT veo_descendants(p_actor)) AND a.role IN('member','manager')),'[]'),
 'submissions',coalesce((SELECT jsonb_agg(to_jsonb(s.*)-'object_path'-'claim_token') FROM veo_submissions s JOIN veo_orders o ON o.id=s.order_id WHERE o.seller_id IN(SELECT veo_descendants(p_actor)) AND veo_can_page(p_actor,o.page_id)),'[]'),
 'sync',coalesce((SELECT jsonb_agg(jsonb_build_object('page_id',p.id,'last_event_at',(SELECT max(occurred_at) FROM veo_event_inbox WHERE page_id=p.id),
 'pending',(SELECT count(*) FROM veo_event_inbox WHERE page_id=p.id AND status<>'done'),'errors',(SELECT count(*) FROM veo_event_inbox WHERE page_id=p.id AND last_error IS NOT NULL),'coverage','Events recorded since launch; earlier conversation coverage is unavailable')) FROM pages p WHERE veo_can_page(p_actor,p.id)),'[]')) INTO result;
 RETURN result;
 END $$;

CREATE FUNCTION public.veo_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE s veo_submissions; o veo_order_facts; tm veo_teams; tg bigint;
 BEGIN
 SELECT * INTO s FROM veo_submissions WHERE id=p_submission;
 SELECT * INTO o FROM veo_order_facts WHERE id=s.order_id;
 IF s.expires_at<=now() OR NOT veo_can_page(s.submitted_by,o.page_id) OR NOT veo_can_page(o.seller_id,o.page_id) OR o.seller_id NOT IN(SELECT veo_descendants(s.submitted_by))
 OR NOT o.converted OR o.paid_minor<>o.total_minor OR o.done_at IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO tm FROM veo_teams WHERE id=o.team_id;
 SELECT telegram_user_id INTO tg FROM veo_worker_mappings WHERE user_id=o.seller_id;
 IF tm.telegram_chat_id IS NULL OR tg IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('submission_id',s.id,'tenant_id',o.tenant_id,'team_id',o.team_id,'seller_id',o.seller_id,
 'telegram_chat_id',tm.telegram_chat_id,'telegram_thread_id',tm.telegram_thread_id,'telegram_user_id',tg,
 'page_id',o.page_id,'contact_id',o.contact_id,'order_id',o.id,'currency',o.currency,'total_minor',o.total_minor,
 'paid_minor',o.paid_minor,'closed_at',o.closed_at,'done_at',o.done_at,'expires_at',s.expires_at,
 'seller_name',(SELECT name FROM users WHERE id=o.seller_id),'contact_name',(SELECT name FROM contacts WHERE id=o.contact_id),
 'description',o.description,'payments',(SELECT jsonb_agg(jsonb_build_object('id',id,'kind',kind,'amount_minor',amount_minor,'occurred_at',occurred_at)) FROM veo_payments WHERE order_id=o.id));
 END $$;

CREATE FUNCTION public.veo_maintenance() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE a record; day date; item jsonb; salary jsonb; previous bigint; delta bigint; start_day date;
 BEGIN
 FOR a IN SELECT v.*,(t.launch_at AT TIME ZONE 'Asia/Manila')::date AS start_day FROM veo_accounts v JOIN veo_tenants t ON t.id=v.tenant_id WHERE t.launch_at IS NOT NULL AND v.role IN('member','manager') LOOP
 PERFORM veo_target(a.user_id,veo_today());
 FOR day IN SELECT generate_series(a.start_day,veo_today()-1,interval '1 day')::date LOOP
 salary:=veo_salary(a.user_id,day);
 FOR item IN SELECT value FROM jsonb_array_elements(salary->'totals') UNION SELECT jsonb_build_object('currency',currency,'gross_minor',0,'commission_minor',0) FROM veo_salary_days d WHERE d.user_id=a.user_id AND d.work_date=day AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(salary->'totals') x WHERE x->>'currency'=d.currency) LOOP
 INSERT INTO veo_salary_days(user_id,work_date,currency,target,closed,done,rate,gross_minor,commission_minor)
 VALUES(a.user_id,day,item->>'currency',(salary->>'target')::integer,(salary->>'closed')::integer,(salary->>'done')::integer,(salary->>'rate')::integer,(item->>'gross_minor')::bigint,(item->>'commission_minor')::bigint) ON CONFLICT DO NOTHING;
 SELECT d.commission_minor+coalesce((SELECT sum(amount_minor) FROM veo_salary_adjustments WHERE user_id=a.user_id AND work_date=day AND currency=d.currency),0) INTO previous FROM veo_salary_days d WHERE d.user_id=a.user_id AND d.work_date=day AND d.currency=item->>'currency' FOR UPDATE;
 delta:=(item->>'commission_minor')::bigint-previous;
 IF delta<>0 THEN INSERT INTO veo_salary_adjustments(user_id,work_date,currency,amount_minor,reason) VALUES(a.user_id,day,item->>'currency',delta,'Verified financial or attribution correction; see workspace audit'); END IF;
 END LOOP;
 END LOOP;
 END LOOP;
 DELETE FROM veo_login_limits WHERE window_at<now()-interval '1 day';
 END $$;

CREATE FUNCTION public.veo_launch(p_owner uuid,p_pages uuid[]) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE tenant uuid; tbl text; cutoff timestamptz; old_owner users;
 BEGIN
 PERFORM pg_advisory_xact_lock(76110510);
 SELECT * INTO old_owner FROM users WHERE id=p_owner;
 IF NOT FOUND OR cardinality(p_pages)<1 OR EXISTS(SELECT 1 FROM unnest(p_pages) pg WHERE NOT EXISTS(SELECT 1 FROM user_pages WHERE user_id=p_owner AND page_id=pg)) THEN RAISE EXCEPTION 'Existing owner and their explicit VEO pages required'; END IF;
 SELECT id,launch_at INTO tenant,cutoff FROM veo_tenants WHERE owner_id=p_owner;
 IF cutoff IS NOT NULL THEN RETURN tenant; END IF;
 IF tenant IS NULL THEN INSERT INTO veo_tenants(owner_id) VALUES(p_owner) RETURNING id INTO tenant; END IF;
 -- Immutable copies preserve old records while current contact identity can continue receiving new events.
 FOREACH tbl IN ARRAY ARRAY['contacts','campaigns','contact_purchases','contact_verified_payments','chatbot_contact_states','contact_profile_snapshots','page_activity_history'] LOOP
 IF to_regclass('public.'||tbl) IS NOT NULL THEN
 EXECUTE format('INSERT INTO veo_archive_records(tenant_id,source_table,record_key,record) SELECT $1,$2,coalesce(to_jsonb(r)->>''id'',md5(to_jsonb(r)::text)),to_jsonb(r) FROM %I r ON CONFLICT DO NOTHING',tbl) USING tenant,tbl;
 END IF;
 END LOOP;
 UPDATE veo_tenants SET launch_at=now() WHERE id=tenant;
 INSERT INTO veo_accounts VALUES(p_owner,tenant,'owner',NULL,true);
 UPDATE users SET role='owner' WHERE id=p_owner;
 UPDATE pages SET veo_enabled=(id=ANY(p_pages)),veo_tenant_id=CASE WHEN id=ANY(p_pages) THEN tenant ELSE NULL END;
 DELETE FROM user_pages WHERE user_id<>p_owner;
 DELETE FROM user_pages WHERE user_id=p_owner AND page_id<>ALL(p_pages);
 IF to_regclass('public.campaigns') IS NOT NULL THEN UPDATE campaigns SET status='cancelled' WHERE status IN('draft','scheduled','sending'); END IF;
 IF to_regclass('public.contact_profile_jobs') IS NOT NULL THEN DELETE FROM contact_profile_jobs; END IF;
 INSERT INTO veo_audit(tenant_id,actor_id,action,after_value) VALUES(tenant,p_owner,'launch',jsonb_build_object('page_ids',p_pages,'archive','read-only'));
 RETURN tenant;
 END $$;

CREATE FUNCTION public.veo_readonly() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Archived and audited records are read-only'; END $$;
CREATE TRIGGER veo_archive_readonly BEFORE UPDATE OR DELETE ON veo_archive_records FOR EACH ROW EXECUTE FUNCTION veo_readonly();
CREATE TRIGGER veo_audit_readonly BEFORE UPDATE OR DELETE ON veo_audit FOR EACH ROW EXECUTE FUNCTION veo_readonly();
CREATE TRIGGER veo_payments_readonly BEFORE UPDATE OR DELETE ON veo_payments FOR EACH ROW EXECUTE FUNCTION veo_readonly();
CREATE TRIGGER veo_salary_readonly BEFORE UPDATE OR DELETE ON veo_salary_days FOR EACH ROW EXECUTE FUNCTION veo_readonly();
CREATE TRIGGER veo_adjustment_readonly BEFORE UPDATE OR DELETE ON veo_salary_adjustments FOR EACH ROW EXECUTE FUNCTION veo_readonly();

-- Only the server's service identity may invoke these functions or read these tables.
DO $$ DECLARE obj record; BEGIN
 FOR obj IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'veo_%' LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',obj.tablename);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',obj.tablename);
 EXECUTE format('GRANT ALL ON public.%I TO service_role',obj.tablename);
 END LOOP;
 FOR obj IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'veo_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',obj.signature);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',obj.signature);
 END LOOP;
END $$;
REVOKE ALL ON veo_order_facts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON veo_order_facts TO service_role;
COMMIT;
