BEGIN;
CREATE TABLE veo_ad_spend_coverage(
 page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,spend_date date NOT NULL,currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),
 amount_minor bigint NOT NULL CHECK(amount_minor>=0),ad_count integer NOT NULL CHECK(ad_count>=0),accounts_checked integer NOT NULL CHECK(accounts_checked>0),
 checked_at timestamptz NOT NULL,report_complete boolean NOT NULL,pht_aligned boolean NOT NULL,PRIMARY KEY(page_id,spend_date,currency)
);
ALTER TABLE veo_ad_spend_coverage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON veo_ad_spend_coverage FROM PUBLIC,anon,authenticated;
GRANT ALL ON veo_ad_spend_coverage TO service_role;
CREATE FUNCTION veo_calendar_spend(p_ids uuid[],p_from date,p_to date) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH recorded AS(SELECT page_id,spend_date,currency,sum(amount)*100 AS amount_minor,bool_and(pht_aligned) AS aligned,
 count(*) AS records,count(DISTINCT ad_id) AS ads,max(checked_at) AS checked_at FROM ad_daily_spend
 WHERE page_id=ANY(p_ids) AND spend_date BETWEEN p_from AND p_to GROUP BY page_id,spend_date,currency),
 keys AS(SELECT page_id,spend_date,currency FROM recorded UNION SELECT page_id,spend_date,currency FROM veo_ad_spend_coverage WHERE page_id=ANY(p_ids) AND spend_date BETWEEN p_from AND p_to),
 reports AS(SELECT k.*,CASE WHEN c.pht_aligned AND c.checked_at>=coalesce(r.checked_at,'-infinity') THEN c.amount_minor
 WHEN r.aligned AND r.records=r.ads THEN r.amount_minor END AS amount_minor,
 coalesce(c.pht_aligned AND c.report_complete AND c.checked_at>=coalesce(r.checked_at,'-infinity')
 AND coalesce(r.records,0)=coalesce(r.ads,0) AND coalesce(r.ads,0)=c.ad_count AND coalesce(r.amount_minor,0)=c.amount_minor,false) AS complete,
 coalesce(r.records,0) AS records,greatest(c.checked_at,r.checked_at) AS checked_at,c.accounts_checked,c.ad_count
 FROM keys k LEFT JOIN recorded r USING(page_id,spend_date,currency) LEFT JOIN veo_ad_spend_coverage c USING(page_id,spend_date,currency))
 SELECT coalesce(jsonb_agg(to_jsonb(reports)),'[]') FROM reports
$$;
REVOKE ALL ON FUNCTION veo_calendar_spend(uuid[],date,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION veo_calendar_spend(uuid[],date,date) TO service_role;
DO $$
DECLARE definition text;old_part text;
BEGIN
 definition:=replace(pg_get_functiondef('veo_calendar_inputs(uuid,date,date,date,uuid)'::regprocedure),E'\r\n',E'\n');
 old_part:=$old$'spend',coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM(SELECT page_id,spend_date,currency,
 CASE WHEN bool_and(pht_aligned) AND count(*)=count(DISTINCT ad_id) THEN sum(amount)*100 END AS amount_minor,
 bool_and(pht_aligned AND report_complete) AND count(*)=count(DISTINCT ad_id) AS complete,count(*) AS records,max(checked_at) AS checked_at
 FROM ad_daily_spend WHERE page_id=ANY(ids) AND spend_date BETWEEN p_from AND p_to GROUP BY page_id,spend_date,currency) s),'[]'),$old$;
 IF strpos(definition,old_part)=0 THEN RAISE EXCEPTION 'Expected calendar spend source is missing';END IF;
 EXECUTE replace(definition,old_part,'''spend'',veo_calendar_spend(ids,p_from,p_to),');
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
