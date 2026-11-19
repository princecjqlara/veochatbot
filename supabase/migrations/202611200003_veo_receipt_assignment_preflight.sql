BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';

-- The form and evidence upload already use this scoped read. Detect a new-sale
-- assignment conflict here instead of after all three photos are uploaded.
-- Existing seller orders/deals remain accessible after a service reassignment.
DO $migration$
DECLARE definition text;needle text:=' RETURN jsonb_build_object(''tenant_id'',a.tenant_id,''page_id'',c.page_id,''contact_id'',c.id,''seller_id'',w.user_id,''team_id'',team,''launch_at'',(SELECT launch_at FROM veo_tenants WHERE id=a.tenant_id));';
BEGIN
 definition:=replace(pg_get_functiondef('public.veo_deal_review_context_before_discipline(uuid,uuid,uuid)'::regprocedure),E'\r\n',E'\n');
 IF strpos(definition,needle)=0 OR strpos(definition,'receipt_assignment_preflight')>0 THEN RAISE EXCEPTION 'Receipt context changed; preserve it for review';END IF;
 EXECUTE replace(definition,needle,$guard$
 -- receipt_assignment_preflight
 IF EXISTS(SELECT 1 FROM veo_client_claims claim WHERE claim.contact_id=c.id AND claim.user_id IS DISTINCT FROM w.user_id)
 AND NOT EXISTS(SELECT 1 FROM veo_orders o WHERE o.contact_id=c.id AND o.page_id=c.page_id AND o.tenant_id=a.tenant_id AND o.seller_id=w.user_id)
 AND NOT EXISTS(SELECT 1 FROM veo_closed_deals d WHERE d.contact_id=c.id AND d.page_id=c.page_id AND d.tenant_id=a.tenant_id AND d.seller_id=w.user_id AND d.voided_at IS NULL) THEN
  RAISE EXCEPTION '%',coalesce(
   (SELECT 'This client is assigned to '||coalesce(nullif(btrim(u.name),''),'another staff member')||'. Select the assigned seller or ask your Manager or Team Leader to reassign the client before submitting a new sale.'
    FROM veo_client_claims claim LEFT JOIN users u ON u.id=claim.user_id WHERE claim.contact_id=c.id AND claim.user_id IS NOT NULL),
   'This client has been released. Ask your Manager or Team Leader to assign the client before submitting a new sale.'
  ) USING ERRCODE='42501';
 END IF;
$guard$||needle);
END $migration$;

INSERT INTO app_private.schema_migrations(version,description)
VALUES('202611200003','Explain receipt seller conflicts before upload while retaining assignment and existing-deal protections') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
