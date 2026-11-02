import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const p = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
const c = '10000000-0000-4000-8000-000000000001', unknown = '10000000-0000-4000-8000-000000000002', foreign = '10000000-0000-4000-8000-000000000003';
describe('calendar cohort and ledger SQL', () => {
 it('counts later conversions/deposits/balances/refunds once in the original cohort while isolating Pages and voided records', async () => {
  const db = new PGlite();
  try {
   await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE ad_daily_spend(page_id uuid,ad_id text,spend_date date);
    CREATE TABLE contacts(id uuid,page_id uuid,first_interaction_at timestamptz,name text,psid text,pipeline_stage text);
    CREATE TABLE ad_contact_sources(contact_id uuid,page_id uuid,first_inquiry_at timestamptz,inquiry_basis text,origin_ad_id text,attribution_status text);
    CREATE TABLE messenger_lead_stage_events(page_id uuid,contact_id uuid,occurred_at timestamptz,applied boolean,stage text);
    CREATE TABLE ad_lead_stage_events(page_id uuid,contact_id uuid,stage_timestamp timestamptz,stage text,previous_stage text);
    CREATE TABLE contact_verified_payments(page_id uuid,contact_id uuid,occurred_at timestamptz,voided_at timestamptz,kind text,currency text,amount_minor bigint,purchase_id uuid);
    CREATE TABLE contact_conversion_cache(contact_id uuid PRIMARY KEY,page_id uuid,first_inquiry_at timestamptz,source_cutoff_at timestamptz,payment_at timestamptz,payment_evidence_id text,complete_history boolean,dirty_at timestamptz);
    INSERT INTO contacts VALUES('${c}','${p}','2020-01-01T12:00:00+08','Customer','psid','converted'),('${unknown}','${p}','2020-01-01T12:00:00+08','Unknown','u','new'),('${foreign}','${other}','2020-01-01T12:00:00+08','Foreign','f','converted');
    INSERT INTO ad_contact_sources VALUES('${c}','${p}','2020-01-01T12:00:00+08','live_message','11','verified_inline'),('${foreign}','${other}','2020-01-01T12:00:00+08','live_message','11','verified_inline');
    INSERT INTO messenger_lead_stage_events VALUES('${p}','${c}','2020-02-03T10:00:00+08',true,'converted');
    INSERT INTO ad_lead_stage_events VALUES('${p}','${c}','2020-02-03T10:00:00+08','converted','qualified');
    INSERT INTO contact_verified_payments VALUES('${p}','${c}','2020-02-04T10:00:00+08',NULL,'deposit','PHP',10000,'${c}'),('${p}','${c}','2020-03-01T10:00:00+08',NULL,'balance','PHP',40000,'${c}'),
     ('${p}','${c}','2020-03-02T10:00:00+08',NULL,'refund','PHP',5000,'${c}'),('${p}','${c}','2020-03-03T10:00:00+08',now(),'full','PHP',999999,'${c}'),
     ('${p}','${c}','2019-12-01T00:00:00Z',NULL,'full','PHP',9999,'${c}'),('${other}','${foreign}','2020-02-04T10:00:00+08',NULL,'full','PHP',888888,'${c}');`);
   await db.exec(readFileSync('supabase/migrations/202611020005_ad_calendar.sql', 'utf8'));
   await db.exec(readFileSync('supabase/migrations/202611020006_calendar_outcome_sources.sql', 'utf8'));
   await db.exec(readFileSync('supabase/migrations/202611020007_calendar_report_performance.sql', 'utf8'));
   await db.exec("INSERT INTO contacts VALUES('10000000-0000-4000-8000-000000000004','" + p + "','2020-01-01T12:00:00+08','Unverified origin','u2','new'); INSERT INTO ad_contact_sources VALUES('10000000-0000-4000-8000-000000000004','" + p + "','2020-01-01T12:00:00+08','recorded_referral','11','unverified')");
   await db.exec("INSERT INTO contact_conversion_cache VALUES('" + c + "','" + p + "','2020-01-01T12:00:00+08','2020-03-05T00:00:00Z','2020-02-04T10:00:00+08','chat-ack',true,NULL),('" + unknown + "','" + p + "','2020-01-01T12:00:00+08','2020-03-05T00:00:00Z','2020-02-05T10:00:00+08','unknown-source-ack',true,'2020-03-06T00:00:00Z')");
   const args = [[p], '2020-01-01T00:00:00+08', '2020-02-01T00:00:00+08'];
   const report = (await db.query<{ result: any }>('SELECT get_ad_calendar_report($1,$2,$3,NULL) AS result', args)).rows[0].result;
   const linked = report.groups.find((row: any) => row.ad_id === '11'); expect(linked).toMatchObject({ inquiries: 1, converted: 1, converted_later: 1, payers: 1, payers_later: 1, pre_inquiry_payments: 1 });
   expect(linked).toMatchObject({ confirmed_payers: 1, chat_confirmed_payers: 1, reviewed_conversations: 1 });
   expect(report.groups.find((row: any) => row.ad_id === null)).toMatchObject({ confirmed_payers: 1, confirmed_payers_later: 1, payers: 0, finance: [], confirmation_stale: 1 });
   expect(linked.stage_lags).toEqual([0, 0, 0, 0, 1]); expect(linked.finance).toHaveLength(1);
   expect(linked.finance[0]).toMatchObject({ currency: 'PHP', received_minor: 50000, refunded_minor: 5000, records: 3, paid_orders: 1 });
   expect(report.groups.find((row: any) => row.ad_id === null).legacy_dates).toBe(1); expect(JSON.stringify(report)).not.toContain('888888');
   const customers = (await db.query<{ result: any }>("SELECT get_ad_calendar_contacts($1,$2,$3,NULL,'paid',0) AS result", args)).rows[0].result;
   expect(customers.total).toBe(1); expect(customers.contacts[0].id).toBe(c); expect(customers.contacts[0].paid_at).toContain('2020-02-04');
   expect(customers.contacts[0].name).toBe('Customer'); expect(customers.contacts[0].psid).toBe('psid');
   const named = (await db.query<{ name: string }>('SELECT name FROM ad_calendar_cohort($1,$2,$3,NULL) WHERE id=$4', [...args, c])).rows[0];
   expect(named.name).toBe('Customer');
   const unknownOnly = (await db.query<{ result: any }>("SELECT get_ad_calendar_report($1,$2,$3,'unknown') AS result", args)).rows[0].result;
   expect(unknownOnly.groups).toHaveLength(1); expect(unknownOnly.groups[0].ad_id).toBeNull();
   expect(unknownOnly.groups[0].inquiries).toBe(2);
   const confirmations = (await db.query<{ result: any }>("SELECT get_ad_calendar_contacts($1,$2,$3,NULL,'confirmed',0) AS result", args)).rows[0].result;
   expect(confirmations.total).toBe(2); expect(confirmations.contacts.find((row: any) => row.id === unknown).confirmation_basis).toBe('conversation_documented');
   await db.query("UPDATE contacts SET pipeline_stage='order_created' WHERE id=$1", [c]);
   const ordered = (await db.query<{ result: any }>('SELECT get_ad_calendar_report($1,$2,$3,NULL) AS result', args)).rows[0].result;
   expect(ordered.groups.find((row: any) => row.ad_id === '11')).toMatchObject({ converted: 1, orders: 1, confirmed_payers: 1 });
   await db.query("UPDATE contacts SET pipeline_stage='not_qualified' WHERE id=$1", [c]);
   const reversed = (await db.query<{ result: any }>('SELECT get_ad_calendar_report($1,$2,$3,NULL) AS result', args)).rows[0].result;
   expect(reversed.groups.find((row: any) => row.ad_id === '11')).toMatchObject({ converted: 0, confirmed_payers: 1 });
   await db.query("UPDATE contacts SET pipeline_stage='converted' WHERE id=$1", [c]);
   await db.query("UPDATE contact_conversion_cache SET payment_at=source_cutoff_at+interval '1 day' WHERE contact_id=$1", [unknown]);
   const invalid = (await db.query<{ result: any }>('SELECT get_ad_calendar_report($1,$2,$3,NULL) AS result', args)).rows[0].result;
   expect(invalid.groups.find((row: any) => row.ad_id === null).confirmed_payers).toBe(0);
   expect((await db.query<{ ok: boolean }>("SELECT has_function_privilege('anon','public.get_ad_calendar_report(uuid[],timestamptz,timestamptz,text)','EXECUTE') AS ok")).rows[0].ok).toBe(false);
   await db.exec(`INSERT INTO contacts SELECT md5('calendar-fixture-'||n)::uuid,'${p}','2020-01-02T12:00:00+08','Cohort lead','test-'||n,CASE WHEN n=1 THEN 'converted' ELSE 'new' END FROM generate_series(1,1100) n;
    INSERT INTO ad_contact_sources SELECT md5('calendar-fixture-'||n)::uuid,'${p}','2020-01-02T12:00:00+08','live_message','11','verified_inline' FROM generate_series(1,1100) n;`);
   const large = (await db.query<{ result: any }>('SELECT get_ad_calendar_report($1,$2,$3,NULL) AS result', args)).rows[0].result;
   const added = large.groups.find((row: any) => row.day === '2020-01-02'); expect(added.inquiries).toBe(1100); expect(added.conversion_time_unknown).toBe(1); expect(added.stage_lags).toEqual([0,0,0,0,0]);
   await expect(db.query('SELECT get_ad_calendar_report($1,$2,$3,NULL)', [[p], '2020-01-01', '2021-01-01'])).rejects.toThrow('scope');
  } finally { await db.close(); }
 }, 30000);
});
