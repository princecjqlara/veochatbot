// Coverage is supplementary: an unavailable count must never become a zero.
export async function loadCalendarCoverage(db: any, pageIds: string[]) {
 if (!pageIds.length) return { available: true, page_contacts_total: 0, contacts_missing_inquiry_date: 0, latest_history_check_at: null };
 const unavailable = { available: false, page_contacts_total: null, contacts_missing_inquiry_date: null, latest_history_check_at: null };
 try {
  const [contacts, missing, history] = await Promise.all([
   db.from('contacts').select('*', { count: 'exact', head: true }).in('page_id', pageIds).abortSignal(AbortSignal.timeout(8000)),
   db.from('ad_lead_cohorts').select('*', { count: 'exact', head: true }).in('page_id', pageIds).is('first_inquiry_at', null).abortSignal(AbortSignal.timeout(8000)),
   db.from('contact_conversion_cache').select('source_cutoff_at').in('page_id', pageIds).eq('complete_history', true).order('source_cutoff_at', { ascending: false, nullsFirst: false }).limit(1).abortSignal(AbortSignal.timeout(8000))
  ]);
  if (contacts.error || missing.error || history.error || !Number.isSafeInteger(contacts.count) || !Number.isSafeInteger(missing.count) || contacts.count < 0 || missing.count < 0 || missing.count > contacts.count) return unavailable;
  return { available: true, page_contacts_total: contacts.count, contacts_missing_inquiry_date: missing.count, latest_history_check_at: history.data?.[0]?.source_cutoff_at || null };
 } catch { return unavailable; }
}
