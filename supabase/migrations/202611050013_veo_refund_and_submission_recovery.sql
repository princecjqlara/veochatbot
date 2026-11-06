BEGIN;
-- A refunded deposit that is subsequently repaid must not reduce commission twice.
-- Each order contributes its current verified net funds to its first completion date.
CREATE OR REPLACE FUNCTION public.veo_salary(p_user uuid,p_day date) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE cd integer; dd integer; target integer; rate integer; totals jsonb;
 BEGIN
 target:=veo_target(p_user,p_day);
 SELECT count(*) FILTER(WHERE closed_date=p_day),count(*) FILTER(WHERE done_date=p_day) INTO cd,dd
 FROM veo_order_facts WHERE seller_id=p_user;
 rate:=CASE WHEN cd>=target AND dd>=target THEN 40 ELSE 35 END;
 SELECT coalesce(jsonb_agg(jsonb_build_object('currency',currency,'gross_minor',gross,'commission_minor',floor(gross*rate::numeric/100))), '[]') INTO totals
 FROM(SELECT currency,sum(paid_minor)::bigint AS gross FROM veo_order_facts WHERE seller_id=p_user AND done_date=p_day GROUP BY currency) y;
 RETURN jsonb_build_object('user_id',p_user,'work_date',p_day,'target',target,'closed',cd,'done',dd,'rate',rate,'totals',totals,'provisional',p_day>=veo_today());
 END $$;

CREATE OR REPLACE FUNCTION public.veo_handoff(p_submission uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 DECLARE s veo_submissions; o veo_order_facts; tm veo_teams; tg bigint;
 BEGIN
 SELECT * INTO s FROM veo_submissions WHERE id=p_submission;
 IF s.id IS NULL OR s.status NOT IN('queued','processing','delivered') THEN RETURN NULL; END IF;
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
REVOKE ALL ON FUNCTION public.veo_salary(uuid,date),public.veo_handoff(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.veo_salary(uuid,date),public.veo_handoff(uuid) TO service_role;
COMMIT;
