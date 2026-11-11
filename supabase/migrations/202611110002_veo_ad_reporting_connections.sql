BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE meta_ads_credentials ADD COLUMN sync_checkpoint jsonb;
ALTER TABLE meta_ads_credentials ADD COLUMN refresh_lease_token uuid;
ALTER TABLE meta_ads_credentials ADD COLUMN refresh_lease_until timestamptz;
CREATE FUNCTION veo_claim_meta_ads_refresh(p_user uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_token IS NULL THEN RETURN false;END IF;
 UPDATE meta_ads_credentials SET refresh_lease_token=p_token,refresh_lease_until=now()+interval '5 minutes'
 WHERE user_id=p_user AND(token_expires_at IS NULL OR token_expires_at>now())
 AND(refresh_lease_until IS NULL OR refresh_lease_until<=now());
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION veo_claim_meta_ads_refresh(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_claim_meta_ads_refresh(uuid,uuid) TO service_role;

-- Reporting must use the same Qualified/Converted rule as the verified ledger.
-- Cash IDs and source types distinguish legitimate payments from duplicate rows
-- and prevent unknown retained commission from becoming a zero cost.
DO $migration$ DECLARE definition text;BEGIN
 definition:=pg_get_functiondef('veo_creative_inputs(uuid,uuid,date,date,text)'::regprocedure);
 IF strpos(definition,$old$AND c.stage='converted'$old$)=0 THEN RAISE EXCEPTION 'Expected creative payment stage gate is missing';END IF;
 definition:=replace(definition,$old$AND c.stage='converted'$old$,$new$AND c.stage IN('qualified','converted')$new$);
 definition:=replace(definition,$old$SELECT o.contact_id,o.currency,p.amount_minor*CASE$old$,
 $new$SELECT 'workspace:'||p.id::text AS payment_key,'workspace'::text AS financial_source,o.contact_id,o.currency,p.amount_minor*CASE$new$);
 definition:=replace(definition,$old$UNION ALL SELECT p.contact_id,p.currency,p.amount_minor*CASE$old$,
 $new$UNION ALL SELECT 'retained:'||p.id::text,'retained'::text,p.contact_id,p.currency,p.amount_minor*CASE$new$);
 IF strpos(definition,'''ad_planning''')=0 THEN RAISE EXCEPTION 'Expected creative report source is missing';END IF;
 definition:=replace(definition,'''ad_planning'',',$new$'reconciled_spend',veo_calendar_spend(ARRAY[p_page],p_from,p_to),
 'attribution_coverage',(SELECT jsonb_build_object('tracked_clients',count(*),'verified_clients',count(*) FILTER(WHERE attribution_status='verified_inline' AND origin_ad_id IS NOT NULL),
 'unattributed_clients',count(*) FILTER(WHERE attribution_status<>'verified_inline' OR origin_ad_id IS NULL)) FROM ad_contact_sources
 WHERE page_id=p_page AND first_inquiry_at>=(p_from::timestamp AT TIME ZONE 'Asia/Manila') AND first_inquiry_at<least(((p_to+1)::timestamp AT TIME ZONE 'Asia/Manila'),now())),
 'ad_planning',$new$);
 EXECUTE definition;
END $migration$;

-- A partial advertising window cannot be compared with all of its paying
-- clients to produce a deceptively low CPA or a larger operating quota.
DO $migration$ DECLARE definition text;old_part text;BEGIN
 definition:=pg_get_functiondef('veo_supply_target(uuid,date,integer)'::regprocedure);
 old_part:='SELECT sum(amount_minor)::numeric INTO spend FROM veo_ad_spend_coverage WHERE page_id=pg AND currency=state.currency AND spend_date>=p_day-14 AND spend_date<least(p_day,veo_today()) AND report_complete AND pht_aligned;';
 IF strpos(definition,old_part)=0 THEN RAISE EXCEPTION 'Expected ad-supported CPA calculation is missing';END IF;
 definition:=replace(definition,'share integer;BEGIN','share integer;lookback_from date;lookback_to date;BEGIN');
 definition:=replace(definition,' SELECT count(DISTINCT contact_id)::int INTO backlog',$new$ lookback_from:=greatest(p_day-14,(SELECT(t.launch_at AT TIME ZONE 'Asia/Manila')::date FROM veo_accounts a JOIN veo_tenants t ON t.id=a.tenant_id WHERE a.user_id=p_user));
 lookback_to:=least(p_day,veo_today())-1;
 SELECT count(DISTINCT contact_id)::int INTO backlog$new$);
 definition:=replace(definition,old_part,$new$SELECT CASE WHEN count(*)=lookback_to-lookback_from+1 AND bool_and((r->>'complete')::boolean)
 THEN sum((r->>'amount_minor')::numeric) END INTO spend FROM jsonb_array_elements(veo_calendar_spend(ARRAY[pg],lookback_from,lookback_to)) r WHERE r->>'currency'=state.currency;$new$);
 definition:=replace(definition,'closed_date>=p_day-14 AND closed_date<least(p_day,veo_today())','closed_date BETWEEN lookback_from AND lookback_to');
 EXECUTE definition;
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
