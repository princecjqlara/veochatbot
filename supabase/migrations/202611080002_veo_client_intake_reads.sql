BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL jit='off';
-- A narrow, transactionally maintained projection keeps queue counts/searches
-- out of the wide retained contact table. Acceptance still checks contacts.
CREATE TABLE veo_intake_contacts(
 id uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,page_id uuid NOT NULL REFERENCES pages(id),
 name text,psid text,pipeline_stage text,last_interaction_at timestamptz NOT NULL
);
CREATE INDEX veo_intake_contacts_activity ON veo_intake_contacts(page_id,last_interaction_at DESC,id);
ALTER TABLE veo_intake_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_intake_contacts FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_intake_contacts TO service_role;
CREATE FUNCTION veo_refresh_intake_contact() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id WHERE p.id=NEW.page_id AND p.veo_enabled AND t.launch_at IS NOT NULL AND NEW.last_interaction_at>=t.launch_at) THEN
  INSERT INTO veo_intake_contacts(id,page_id,name,psid,pipeline_stage,last_interaction_at) VALUES(NEW.id,NEW.page_id,NEW.name,NEW.psid,NEW.pipeline_stage,NEW.last_interaction_at)
  ON CONFLICT(id) DO UPDATE SET page_id=EXCLUDED.page_id,name=EXCLUDED.name,psid=EXCLUDED.psid,pipeline_stage=EXCLUDED.pipeline_stage,last_interaction_at=EXCLUDED.last_interaction_at;
 ELSE DELETE FROM veo_intake_contacts WHERE id=NEW.id;END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER veo_refresh_intake_contact AFTER INSERT OR UPDATE OF page_id,name,psid,pipeline_stage,last_interaction_at ON contacts FOR EACH ROW EXECUTE FUNCTION veo_refresh_intake_contact();
INSERT INTO veo_intake_contacts(id,page_id,name,psid,pipeline_stage,last_interaction_at)
 SELECT c.id,c.page_id,c.name,c.psid,c.pipeline_stage,c.last_interaction_at FROM pages p JOIN veo_tenants t ON t.id=p.veo_tenant_id
 JOIN contacts c ON c.page_id=p.id AND c.last_interaction_at>=t.launch_at WHERE p.veo_enabled AND t.launch_at IS NOT NULL;
REVOKE ALL ON FUNCTION veo_refresh_intake_contact() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_refresh_intake_contact() TO service_role;

CREATE OR REPLACE FUNCTION veo_intake_page(p_actor uuid,p_view text DEFAULT 'pool',p_page uuid DEFAULT NULL,p_search text DEFAULT '',p_offset integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET jit='off' SET plan_cache_mode='force_custom_plan' AS $$
DECLARE a veo_accounts;launched timestamptz;result jsonb;ids uuid[];branch uuid[];search_id uuid;BEGIN
 SELECT * INTO a FROM veo_accounts WHERE user_id=p_actor AND active;SELECT launch_at INTO launched FROM veo_tenants WHERE id=a.tenant_id;
 IF a.user_id IS NULL OR launched IS NULL OR(p_page IS NOT NULL AND NOT veo_can_page(p_actor,p_page)) THEN RAISE EXCEPTION 'New-client access denied' USING ERRCODE='42501';END IF;
 IF p_view NOT IN('pool','offers','assigned') OR length(p_search)>200 OR p_offset<0 OR p_offset>100000 THEN RAISE EXCEPTION 'Invalid new-client filters';END IF;
 IF p_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN search_id:=p_search::uuid;END IF;
 SELECT coalesce(array_agg(id),'{}') INTO ids FROM pages WHERE veo_can_page(p_actor,id) AND(p_page IS NULL OR id=p_page);
 SELECT coalesce(array_agg(id),'{}') INTO branch FROM veo_descendants(p_actor) id;
 WITH contact_base AS MATERIALIZED(
 SELECT id,page_id,name,psid,pipeline_stage,last_interaction_at FROM veo_intake_contacts WHERE p_view='pool' AND page_id=ANY(ids) AND(search_id IS NULL OR id=search_id)
 UNION ALL
 SELECT c.id,c.page_id,c.name,c.psid,c.pipeline_stage,c.last_interaction_at FROM veo_client_claims cc JOIN contacts c ON c.id=cc.contact_id AND c.page_id=cc.page_id
 WHERE p_view='assigned' AND cc.user_id=ANY(branch) AND cc.page_id=ANY(ids) AND(search_id IS NULL OR c.id=search_id)
 UNION ALL
 SELECT c.id,c.page_id,c.name,c.psid,c.pipeline_stage,c.last_interaction_at FROM veo_client_offers o JOIN contacts c ON c.id=o.contact_id AND c.page_id=o.page_id
 WHERE p_view='offers' AND o.status='pending' AND o.expires_at>now() AND(o.offered_to=p_actor OR(a.role<>'member' AND o.offered_to=ANY(branch))) AND o.page_id=ANY(ids) AND(search_id IS NULL OR c.id=search_id)),
 candidates AS MATERIALIZED(
 SELECT c.id,c.page_id,c.name,c.psid,c.pipeline_stage,c.last_interaction_at,cc.user_id owner_id,
 o.id offer_id,o.offered_to,o.offered_by,o.expires_at offer_expires_at,
 CASE WHEN o.id IS NOT NULL THEN cc.user_id IS NOT DISTINCT FROM o.previous_owner AND veo_intake_can_offer(o.offered_by,c.id,o.offered_to) ELSE false END offer_authorized,
 (o.id IS NULL OR o.offered_by=p_actor OR(a.role<>'member' AND o.offered_to=ANY(branch) AND(o.previous_owner IS NULL OR o.previous_owner=ANY(branch)))) may_replace_offer,
 EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=c.id) OR EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=c.id AND voided_at IS NULL) has_sales
 FROM contact_base c LEFT JOIN veo_client_claims cc ON cc.contact_id=c.id
 LEFT JOIN veo_client_offers o ON o.contact_id=c.id AND o.status='pending' AND o.expires_at>now()
 WHERE(p_search='' OR c.id=search_id OR strpos(lower(concat_ws(' ',c.id::text,c.name,c.psid)),lower(p_search))>0 OR EXISTS(SELECT 1 FROM pages pg WHERE pg.id=c.page_id AND strpos(lower(pg.name),lower(p_search))>0))
 AND CASE p_view
 WHEN 'pool' THEN cc.user_id IS NULL AND cc.released_at IS NULL AND o.id IS NULL AND c.last_interaction_at>=launched AND c.pipeline_stage NOT IN('not_qualified','opted_out')
 AND NOT EXISTS(SELECT 1 FROM veo_orders WHERE contact_id=c.id) AND NOT EXISTS(SELECT 1 FROM veo_closed_deals WHERE contact_id=c.id AND voided_at IS NULL)
 WHEN 'offers' THEN o.offered_to=p_actor OR(a.role<>'member' AND o.offered_to=ANY(branch))
 ELSE cc.user_id=ANY(branch) END),
 roster AS MATERIALIZED(SELECT w.user_id id,u.name,w.role,
 EXISTS(SELECT 1 FROM veo_intake_readiness r WHERE r.user_id=w.user_id AND r.status='ready' AND r.expires_at>now()) ready,
 (SELECT expires_at FROM veo_intake_readiness WHERE user_id=w.user_id) ready_until,
 ARRAY(SELECT id FROM unnest(ids) id WHERE veo_can_page(w.user_id,id)) page_ids
 FROM veo_accounts w JOIN users u ON u.id=w.user_id WHERE w.tenant_id=a.tenant_id AND w.active AND w.role IN('member','manager')
 AND(w.user_id=ANY(branch) OR(a.role='member' AND(w.user_id=a.parent_id OR(w.role='member' AND w.parent_id=a.parent_id)))))
 SELECT jsonb_build_object('as_of',clock_timestamp(),'role',a.role,'can_sell',a.role IN('member','manager'),
 'readiness',jsonb_build_object('ready',EXISTS(SELECT 1 FROM veo_intake_readiness WHERE user_id=p_actor AND status='ready' AND expires_at>now()),'expires_at',(SELECT expires_at FROM veo_intake_readiness WHERE user_id=p_actor)),
 'roster',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY name,id) FROM roster r),'[]'),
 'total',(SELECT count(*) FROM candidates),'items',coalesce((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('page_name',pg.name,'owner_name',u.name,'offered_to_name',ou.name,
 'can_offer',c.may_replace_offer AND c.pipeline_stage NOT IN('not_qualified','opted_out') AND((a.role<>'member' AND(c.owner_id IS NULL OR c.owner_id=ANY(branch))) OR(c.owner_id=p_actor AND NOT c.has_sales))) ORDER BY c.last_interaction_at DESC,c.id)
 FROM(SELECT * FROM candidates ORDER BY last_interaction_at DESC,id LIMIT 50 OFFSET p_offset) c
 JOIN pages pg ON pg.id=c.page_id LEFT JOIN users u ON u.id=c.owner_id LEFT JOIN users ou ON ou.id=c.offered_to),'[]'),
 'limit',50,'offset',p_offset,'source','Tokko current client assignments; Ready/Busy is separate from tomorrow attendance') INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION veo_intake_page(uuid,text,uuid,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_intake_page(uuid,text,uuid,text,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
