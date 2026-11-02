import { DatabaseReadTimeout, requestDeadline } from './request-deadline';
type Report = { groups: any[]; as_of?: string };
type Scope = { pageIds: string[]; from: string; to: string; adId: string | null };
type Db = { rpc: (name: string, args: Record<string, unknown>) => any };
export class CalendarReportError extends Error {
 readonly retryable: boolean;
 constructor(readonly code: string, readonly sourceCode?: string) {
  super(code === 'CALENDAR_TIMEOUT' ? 'The calendar report took too long. Refresh it or select one Page to retry.' : 'Calendar records are temporarily unavailable. Please retry.');
  this.retryable = code === 'CALENDAR_TIMEOUT';
 }
}
const timeout = (error: any) => String(error?.code) === '57014';
/** A failed chunk never becomes an empty or partially successful report. */
export async function loadCalendarReport(db: Db, scope: Scope): Promise<Report> {
 const ids = [...new Set(scope.pageIds)];
 if (!ids.length) return { groups: [], as_of: new Date().toISOString() };
 const deadline = Date.now() + 65000;
 const query = async (pageIds: string[]) => {
  if (Date.now() >= deadline) throw new CalendarReportError('CALENDAR_TIMEOUT', 'DEADLINE');
  let reply: any;
  try { reply = await requestDeadline(signal => {
   const query = db.rpc('get_ad_calendar_report', { p_page_ids: pageIds, p_from: scope.from, p_to: scope.to, p_ad_id: scope.adId });
   return typeof query?.abortSignal === 'function' ? query.abortSignal(signal) : query;
  }, Math.min(20000, deadline - Date.now())); }
  catch (error) { if (error instanceof DatabaseReadTimeout) throw error; throw new CalendarReportError('CALENDAR_UNAVAILABLE', 'TRANSPORT'); }
  if (!reply || typeof reply !== 'object') throw new CalendarReportError('CALENDAR_UNAVAILABLE', 'INVALID_REPORT');
  if (reply.error) {
   if (timeout(reply.error)) return null;
   throw new CalendarReportError('CALENDAR_UNAVAILABLE', reply.error.code);
  }
  if (!Array.isArray(reply.data?.groups)) throw new CalendarReportError('CALENDAR_UNAVAILABLE', 'INVALID_REPORT');
  return reply.data as Report;
 };
 const first = await query(ids);
 if (first) return first;
 if (ids.length === 1) throw new CalendarReportError('CALENDAR_TIMEOUT', '57014');
 const queue: string[][] = [];
 for (let offset = 0; offset < ids.length; offset += 5) queue.push(ids.slice(offset, offset + 5));
 const completed: Report[] = [];
 let failure: unknown;
 await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
  while (queue.length && !failure) {
   const chunk = queue.shift()!;
   try {
    const result = await query(chunk);
    if (result) completed.push(result);
    else if (chunk.length > 1) {
     const middle = Math.ceil(chunk.length / 2); queue.push(chunk.slice(0, middle), chunk.slice(middle));
    } else throw new CalendarReportError('CALENDAR_TIMEOUT', '57014');
   } catch (error) { failure = error; }
  }
 }));
 if (failure) throw failure;
 const dates = completed.map(report => report.as_of).filter((at): at is string => Boolean(at)).sort();
 return { groups: completed.flatMap(report => report.groups), as_of: dates.at(-1) };
}
