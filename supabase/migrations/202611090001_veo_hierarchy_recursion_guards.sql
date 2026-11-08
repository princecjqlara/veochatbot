BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';

CREATE INDEX IF NOT EXISTS veo_accounts_parent_tenant_guard_idx
 ON public.veo_accounts(parent_id, tenant_id, user_id);

-- Include departed hierarchy nodes so historical reports and their active
-- descendants retain their existing semantics. Invalid cycles fail closed.
CREATE OR REPLACE FUNCTION public.veo_branch(p_actor uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE branch AS (
  SELECT a.user_id,a.tenant_id,ARRAY[a.user_id] AS visited,false AS cycle,1 AS depth
  FROM veo_accounts a WHERE a.user_id=p_actor AND a.active
  UNION ALL
  SELECT a.user_id,a.tenant_id,b.visited||a.user_id,a.user_id=ANY(b.visited),b.depth+1
  FROM veo_accounts a JOIN branch b ON a.parent_id=b.user_id AND a.tenant_id=b.tenant_id
  WHERE NOT b.cycle AND b.depth<64
 )
 SELECT b.user_id FROM branch b
 WHERE NOT EXISTS (
  SELECT 1 FROM branch invalid WHERE invalid.cycle OR (invalid.depth=64 AND EXISTS(
   SELECT 1 FROM veo_accounts child WHERE child.parent_id=invalid.user_id AND child.tenant_id=invalid.tenant_id
  ))
 )
$$;

CREATE OR REPLACE FUNCTION public.veo_descendants(p_actor uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT user_id FROM veo_accounts WHERE user_id IN(SELECT veo_branch(p_actor)) AND active
$$;

CREATE OR REPLACE FUNCTION public.veo_grant_parent(p_user uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE parents AS (
  SELECT p.user_id,p.parent_id,p.tenant_id,p.active,p.departed_at,a.tenant_id AS actor_tenant,
   ARRAY[p.user_id] AS visited,false AS cycle,1 AS depth
  FROM veo_accounts a JOIN veo_accounts p ON p.user_id=a.parent_id WHERE a.user_id=p_user
  UNION ALL
  SELECT a.user_id,a.parent_id,a.tenant_id,a.active,a.departed_at,p.actor_tenant,
   p.visited||a.user_id,a.user_id=ANY(p.visited),p.depth+1
  FROM veo_accounts a JOIN parents p ON a.user_id=p.parent_id
  WHERE p.departed_at IS NOT NULL AND NOT p.cycle AND p.depth<64
 )
 SELECT user_id FROM parents WHERE active AND NOT EXISTS (
  SELECT 1 FROM parents invalid WHERE invalid.cycle OR invalid.tenant_id<>invalid.actor_tenant
   OR (invalid.depth=64 AND invalid.departed_at IS NOT NULL AND invalid.parent_id IS NOT NULL)
 ) ORDER BY depth LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.veo_can_page(p_actor uuid,p_page uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE parents AS (
  SELECT a.user_id,a.parent_id,a.tenant_id,a.active,a.departed_at,
   ARRAY[a.user_id] AS visited,false AS cycle,1 AS depth
  FROM veo_accounts a WHERE a.user_id=p_actor
  UNION ALL
  SELECT b.user_id,b.parent_id,b.tenant_id,b.active,b.departed_at,
   c.visited||b.user_id,b.user_id=ANY(c.visited),c.depth+1
  FROM veo_accounts b JOIN parents c ON c.parent_id=b.user_id
  WHERE NOT c.cycle AND c.depth<64
 )
 SELECT EXISTS (
  SELECT 1 FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id
  JOIN pages p ON p.id=p_page AND p.veo_tenant_id=a.tenant_id AND p.veo_enabled
  WHERE a.user_id=p_actor AND a.active AND t.launch_at IS NOT NULL
   AND EXISTS(SELECT 1 FROM parents WHERE parent_id IS NULL)
   AND NOT EXISTS(SELECT 1 FROM parents b WHERE b.cycle OR b.tenant_id<>a.tenant_id OR (b.depth=64 AND b.parent_id IS NOT NULL))
   AND NOT EXISTS(
    SELECT 1 FROM parents b WHERE (b.departed_at IS NULL OR b.user_id=p_actor)
     AND (NOT b.active OR NOT EXISTS(SELECT 1 FROM user_pages up WHERE up.user_id=b.user_id AND up.page_id=p_page))
   )
 )
$$;

REVOKE ALL ON FUNCTION public.veo_branch(uuid),public.veo_descendants(uuid),public.veo_grant_parent(uuid),public.veo_can_page(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_branch(uuid),public.veo_descendants(uuid),public.veo_grant_parent(uuid),public.veo_can_page(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
