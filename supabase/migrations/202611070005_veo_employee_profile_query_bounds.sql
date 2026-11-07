BEGIN;
-- Begin with this worker's client IDs. A shared Page can have years of contacts;
-- opening an employee with no clients must not walk every one of those contacts.
DO $migration$ DECLARE definition text; old_part text; BEGIN
 definition:=replace(pg_get_functiondef('veo_employee_profile(uuid,uuid,date,date,uuid)'::regprocedure),E'\r\n',E'\n');
 old_part:=$old$ client_list AS(SELECT$old$;
 IF strpos(definition,old_part)=0 THEN RAISE EXCEPTION 'Expected employee client query is missing'; END IF;
 definition:=replace(definition,old_part,$new$ client_ids AS MATERIALIZED(SELECT contact_id FROM personal UNION
 SELECT cc.contact_id FROM veo_client_claims cc JOIN visible_pages p ON p.id=cc.page_id WHERE cc.user_id=p_worker AND cc.tenant_id=actor.tenant_id),
 client_list AS(SELECT$new$);
 old_part:=$old$ FROM contacts c JOIN visible_pages p ON p.id=c.page_id LEFT JOIN veo_client_claims cc ON cc.contact_id=c.id
 WHERE cc.user_id=p_worker OR EXISTS(SELECT 1 FROM personal f WHERE f.contact_id=c.id))$old$;
 IF strpos(definition,old_part)=0 THEN RAISE EXCEPTION 'Expected employee client join is missing'; END IF;
 definition:=replace(definition,old_part,$new$ FROM client_ids ids JOIN contacts c ON c.id=ids.contact_id JOIN visible_pages p ON p.id=c.page_id LEFT JOIN veo_client_claims cc ON cc.contact_id=c.id)$new$);
 EXECUTE definition;
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
