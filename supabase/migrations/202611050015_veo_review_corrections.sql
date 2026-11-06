BEGIN;
ALTER TABLE veo_contact_details ADD COLUMN manual_name text;
ALTER TABLE veo_contact_details ADD COLUMN has_manual_name boolean NOT NULL DEFAULT false;

-- Preserve a deliberate identity correction against later Facebook and AI updates.
CREATE FUNCTION public.veo_preserve_contact_name() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE details veo_contact_details;
 BEGIN
 SELECT * INTO details FROM veo_contact_details WHERE contact_id=NEW.id;
 IF FOUND AND details.has_manual_name THEN NEW.name:=details.manual_name; END IF;
 RETURN NEW;
 END $$;
CREATE TRIGGER veo_preserve_contact_name BEFORE UPDATE OF name ON contacts FOR EACH ROW EXECUTE FUNCTION veo_preserve_contact_name();

-- Amend the existing authoritative action in place. Fail closed if its expected
-- definition changed, rather than silently skipping an authorization correction.
DO $migration$
 DECLARE definition text; previous text; replacement text;
 BEGIN
 definition:=pg_get_functiondef('public.veo_action(uuid,text,jsonb)'::regprocedure);
 previous:=$old$IF EXISTS(SELECT 1 FROM unnest(ids) p WHERE NOT veo_can_page(p_actor,p)) THEN RAISE EXCEPTION 'Page outside your scope' USING ERRCODE='42501'; END IF;$old$;
 replacement:=$new$IF EXISTS(SELECT 1 FROM unnest(ids) p WHERE NOT veo_can_page(p_actor,p) OR NOT veo_can_page((SELECT parent_id FROM veo_accounts WHERE user_id=u),p)) THEN RAISE EXCEPTION 'Page outside your or the immediate supervisor scope' USING ERRCODE='42501'; END IF;$new$;
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Account authorization migration source mismatch'; END IF;
 definition:=replace(definition,previous,replacement);
 previous:=$old$pay.reference<>p_data->>'reference' THEN$old$;
 replacement:=$new$pay.reference<>btrim(p_data->>'reference') OR pay.occurred_at IS DISTINCT FROM (p_data->>'occurred_at')::timestamptz THEN$new$;
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Payment idempotency migration source mismatch'; END IF;
 definition:=replace(definition,previous,replacement);
 previous:=$old$INSERT INTO veo_contact_details VALUES(cid,p_data->'fields',p_actor,now()) ON CONFLICT(contact_id) DO UPDATE SET fields=veo_contact_details.fields||EXCLUDED.fields,updated_by=p_actor,updated_at=now() RETURNING to_jsonb(veo_contact_details.*) INTO result;$old$;
 replacement:=$new$INSERT INTO veo_contact_details(contact_id,fields,updated_by,updated_at,manual_name,has_manual_name)
 VALUES(cid,p_data->'fields',p_actor,now(),nullif(btrim(p_data->>'name'),''),p_data ? 'name')
 ON CONFLICT(contact_id) DO UPDATE SET fields=veo_contact_details.fields||EXCLUDED.fields,updated_by=p_actor,updated_at=now(),
 manual_name=CASE WHEN EXCLUDED.has_manual_name THEN EXCLUDED.manual_name ELSE veo_contact_details.manual_name END,
 has_manual_name=veo_contact_details.has_manual_name OR EXCLUDED.has_manual_name RETURNING to_jsonb(veo_contact_details.*) INTO result;$new$;
 IF strpos(definition,previous)=0 THEN RAISE EXCEPTION 'Contact correction migration source mismatch'; END IF;
 definition:=replace(definition,previous,replacement);
 EXECUTE definition;
 END $migration$;

CREATE FUNCTION public.veo_orders_page(p_actor uuid,p_day date,p_view text DEFAULT 'dashboard',p_page uuid DEFAULT NULL,
 p_search text DEFAULT '',p_offset integer DEFAULT 0,p_limit integer DEFAULT 50) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE scope jsonb; result jsonb;
 BEGIN
 scope:=veo_scope(p_actor);
 IF scope IS NULL OR scope->>'launch_at' IS NULL OR (p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 IF p_day<((scope->>'launch_at')::timestamptz AT TIME ZONE 'Asia/Manila')::date OR p_day>veo_today() OR
 p_view NOT IN('dashboard','clients','closed','done','salary','accounts','sync') OR p_offset<0 OR p_offset>10000000 OR p_limit<1 OR p_limit>100 OR length(p_search)>200 THEN RAISE EXCEPTION 'Invalid order filters'; END IF;
 WITH eligible AS MATERIALIZED(
 SELECT to_jsonb(o.*)||jsonb_build_object('contact_name',c.name,'seller_name',u.name) AS value,o.created_at,o.id
 FROM veo_order_facts o JOIN contacts c ON c.id=o.contact_id JOIN users u ON u.id=o.seller_id
 WHERE o.tenant_id=(scope->>'tenant_id')::uuid AND o.seller_id IN(SELECT veo_descendants(p_actor)) AND veo_can_page(p_actor,o.page_id)
 AND(p_page IS NULL OR o.page_id=p_page) AND(p_view<>'clients' OR o.seller_id=p_actor)
 AND(p_view<>'closed' OR o.closed_date=p_day) AND(p_view<>'done' OR o.done_date=p_day)
 AND(p_search='' OR strpos(lower(concat_ws(' ',c.name,o.description,u.name)),lower(p_search))>0)
 ), selected AS(SELECT * FROM eligible ORDER BY created_at DESC,id DESC OFFSET p_offset LIMIT p_limit)
 SELECT jsonb_build_object('orders',coalesce((SELECT jsonb_agg(value ORDER BY created_at DESC,id DESC) FROM selected),'[]'),
 'total',(SELECT count(*) FROM eligible),'offset',p_offset,'limit',p_limit) INTO result;
 RETURN result;
 END $$;

REVOKE ALL ON FUNCTION veo_preserve_contact_name(),veo_orders_page(uuid,date,text,uuid,text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_preserve_contact_name(),veo_orders_page(uuid,date,text,uuid,text,integer,integer) TO service_role;
COMMIT;
