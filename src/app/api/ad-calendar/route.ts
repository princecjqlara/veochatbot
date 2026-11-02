import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getUserPageIds } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';
import { buildAdCalendar, calendarRange, phtDay } from '@/lib/ad-calendar';
import { profileAdFields } from '@/lib/contact-profile-sources';
import { CalendarReportError, loadCalendarReport } from '@/lib/ad-calendar-report';
import { loadCalendarCoverage } from '@/lib/ad-calendar-coverage';
import { DatabaseReadTimeout, requestDeadline } from '@/lib/request-deadline';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
 const session = await getSessionFromRequest(request);
 if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 const q = request.nextUrl.searchParams, month = q.get('month') || phtDay(Date.now()).slice(0, 7), adId = q.get('adId')?.trim() || null;
 let range: ReturnType<typeof calendarRange>;
 try {
  range = calendarRange(month);
  if (adId && adId !== 'unknown' && !/^\d{1,100}$/.test(adId)) throw Error('Invalid ad filter');
  if (q.get('day') && !range.days.includes(q.get('day')!)) throw Error('Choose a day within this month');
  if (q.get('view') && !['contacts', 'pages'].includes(q.get('view')!)) throw Error('Invalid calendar view');
 } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
 try {
  const userId = session.user.id;
  const memberships = await requestDeadline(signal => getUserPageIds(userId, signal), 10000), pageId = q.get('pageId');
  if (pageId && !memberships.includes(pageId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const ids = pageId ? [pageId] : memberships;
  const db = getSupabaseAdmin();
  if (q.get('view') === 'pages') {
   if (!memberships.length) return NextResponse.json({ pages: [] }, { headers: { 'Cache-Control': 'no-store' } });
   const pages = await requestDeadline(signal => db.from('pages').select('id,name,fb_page_id,messaging_auto_tag_checked_at,messaging_auto_tag_last_error').in('id', memberships).abortSignal(signal), 10000);
   if (pages.error) throw Error('Could not load authorized Pages');
   return NextResponse.json({ pages: pages.data || [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (ids.length > 50) return NextResponse.json({ error: 'Select one Page for this report' }, { status: 400 });
  if (q.get('view') === 'contacts') {
   const day = q.get('day'); if (!day) return NextResponse.json({ error: 'Choose an inquiry day' }, { status: 400 });
   const status = q.get('status') || 'all', offset = Number(q.get('offset') || 0);
   if (!['all', 'converted', 'paid', 'unconverted', 'confirmed', 'orders'].includes(status) || !Number.isInteger(offset) || offset < 0 || offset > 1000000) return NextResponse.json({ error: 'Invalid cohort filter' }, { status: 400 });
   if (!ids.length) return NextResponse.json({ total: 0, contacts: [] }, { headers: { 'Cache-Control': 'no-store' } });
   const from = Date.parse(day + 'T00:00:00+08:00');
   const result = await requestDeadline(signal => db.rpc('get_ad_calendar_contacts', { p_page_ids: ids, p_from: new Date(from).toISOString(), p_to: new Date(from + 86400000).toISOString(), p_ad_id: adId, p_status: status, p_offset: offset }).abortSignal(signal), 20000);
   if (result.error) throw Error('Could not load this inquiry cohort');
   return NextResponse.json(result.data, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!ids.length) return NextResponse.json({ ...buildAdCalendar({ month, groups: [], spend: [], inventory: [], adId, selectedDay: q.get('day') || undefined }), coverage: await loadCalendarCoverage(db, []), pages: [] }, { headers: { 'Cache-Control': 'no-store' } });
  const pages = await requestDeadline(signal => db.from('pages').select('id,name,fb_page_id,messaging_auto_tag_checked_at,messaging_auto_tag_last_error').in('id', memberships).abortSignal(signal), 10000);
  if (pages.error) throw Error('Could not load authorized Pages');
  async function inventory() {
   const rows: any[] = [];
   for (let offset = 0; offset < 2000; offset += 1000) {
    const result = await requestDeadline(signal => db.from('ad_source_catalog').select('page_id,' + profileAdFields).in('page_id', ids).order('page_id').order('ad_id').range(offset, offset + 999).abortSignal(signal), 10000);
    if (result.error) throw Error('Could not read verified ad inventory');
    rows.push(...result.data || []); if ((result.data || []).length < 1000) return rows;
   }
   throw Error('Select a single Page to report this ad inventory completely');
  }
  async function spend() {
   if (adId === 'unknown') return [];
   const rows: any[] = [];
   for (let offset = 0; offset < 100000; offset += 1000) {
    let query = db.from('ad_daily_spend').select('*').in('page_id', ids).gte('spend_date', range.days[0]).lte('spend_date', range.days.at(-1)!)
     .order('page_id').order('ad_id').order('spend_date').order('account_id').range(offset, offset + 999);
    if (adId) query = query.eq('ad_id', adId);
    const result = await requestDeadline(signal => query.abortSignal(signal), 10000); if (result.error) throw Error('Could not load actual ad spend');
    rows.push(...result.data || []); if ((result.data || []).length < 1000) return rows;
   }
   throw Error('Select a single Page to report this month completely');
  }
  const [cohort, ads, daily, coverage] = await Promise.all([
   loadCalendarReport(db, { pageIds: ids, from: range.from, to: range.to, adId }), inventory(), spend(), loadCalendarCoverage(db, ids)
  ]);
  const result = buildAdCalendar({ month, groups: cohort.groups, spend: daily, inventory: ads, adId, selectedDay: q.get('day') || undefined });
  return NextResponse.json({ ...result, outcome_as_of: cohort.as_of || result.generated_at, coverage, pages: pages.data || [] }, { headers: { 'Cache-Control': 'no-store' } });
 } catch (error) {
  if (error instanceof DatabaseReadTimeout) return NextResponse.json({ error: error.message, code: error.code, retryable: true }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  if (error instanceof CalendarReportError) {
   console.error('[ad-calendar] Report failed', { code: error.code, sourceCode: error.sourceCode, month });
   return NextResponse.json({ error: error.message, code: error.code, retryable: error.retryable }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json({ error: (error as Error).message || 'Ad calendar is temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
 }
}
