BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

-- Approved Done Deal evidence verifies completion independently of Telegram
-- delivery. A full upfront payment alone must keep its production deadline.
CREATE INDEX veo_submission_completed_project ON public.veo_submissions(order_id)
 WHERE status='delivered' AND receipt_kind='done';
DO $migration$
DECLARE definition text;columns text;
BEGIN
 definition:=rtrim(pg_get_viewdef('public.veo_work_facts'::regclass,true),E';\n ');
 SELECT string_agg(CASE attname
  WHEN 'overdue' THEN 'f.overdue AND NOT completion.verified_done_deal AS overdue'
  WHEN 'overdue_hours' THEN 'CASE WHEN completion.verified_done_deal THEN 0 ELSE f.overdue_hours END AS overdue_hours'
  ELSE format('f.%I',attname) END,',' ORDER BY attnum) INTO columns
 FROM pg_attribute WHERE attrelid='public.veo_work_facts'::regclass AND attnum>0 AND NOT attisdropped;
 EXECUTE 'CREATE OR REPLACE VIEW public.veo_work_facts AS SELECT '||columns||',completion.verified_done_deal FROM ('||definition||') f
 CROSS JOIN LATERAL (SELECT f.order_created AND (
  EXISTS(SELECT 1 FROM public.veo_deal_reviews r WHERE r.order_id=f.id AND r.receipt_kind=''done'' AND r.status=''approved'')
  OR (f.done_at IS NOT NULL AND EXISTS(SELECT 1 FROM public.veo_submissions s WHERE s.order_id=f.id AND s.receipt_kind=''done'' AND s.status=''delivered''))
 ) AS verified_done_deal) completion';
END $migration$;
ALTER FUNCTION public.veo_finance_days(uuid,date,date,uuid,uuid) SET statement_timeout='15s';
INSERT INTO app_private.schema_migrations(version,description) VALUES('202611160003','Clear production overdue warnings for verified completed Done Deals; preserve upfront payment deadlines') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
