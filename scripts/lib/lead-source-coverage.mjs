// A successful command is not proof that every Page and history was read.
export function sourceCoverageComplete(pages, errors, expectedPages) {
 return Number.isSafeInteger(expectedPages) && expectedPages >= 0 && pages.length === expectedPages &&
  new Set(pages.map(page => page.page_id)).size === expectedPages &&
  pages.every(page => page.page_id && page.complete === true && !page.error && !page.skipped && !page.blocked && !(page.failed_histories > 0)) && errors.length === 0;
}

export function backfillCoverageComplete(inventory, histories) {
 if (inventory?.scope_check_complete === false || histories?.scope_check_complete === false || inventory?.scope !== histories?.scope) return false;
 if (!inventory?.passed || !histories?.passed || !Number.isFinite(Date.parse(inventory.completed_at)) || !Number.isFinite(Date.parse(histories.completed_at)) || Date.parse(histories.completed_at) < Date.parse(inventory.completed_at) || !inventory.coverage_complete || !histories.coverage_complete) return false;
 if (!sourceCoverageComplete(inventory.pages || [], inventory.errors || [], inventory.expected_pages) || !sourceCoverageComplete(histories.pages || [], histories.errors || [], histories.expected_pages)) return false;
 const indexes = new Map(inventory.pages.map(page => [page.page_id, page.index_started_at]));
 return histories.pages.length === indexes.size && histories.pages.every(page => indexes.has(page.page_id) && Number.isFinite(Date.parse(page.index_started_at)) && indexes.get(page.page_id) === page.index_started_at);
}

export function conversationIndex(page, previous, now = Date.now()) {
 // A transient read failure must retain its cursor and already downloaded rows.
 if (previous && previous.page_id === page.id && previous.fb_page_id === page.fb_page_id && previous.complete === false && previous.next && Array.isArray(previous.conversations)) {
  const resumed = { ...previous, conversations: [...previous.conversations], resumed_at: new Date(now).toISOString() };
  delete resumed.error;
  return resumed;
 }
 return { page_id: page.id, fb_page_id: page.fb_page_id, page: page.name, started_at: new Date(now).toISOString(), conversations: [], next: page.fb_page_id + '/conversations?fields=id,participants,updated_time&limit=100', complete: false };
}

export function databaseRetryDelay(error, failures) {
 const normal = Math.min(300000, 30000 * 2 ** Math.min(Math.max(0, failures - 1), 4));
 return /ECIRCUITBREAKER|circuit breaker/i.test(error?.message || '') ? Math.max(150000, normal) : normal;
}

export function retryableSourceError(error) {
 const code = Number(error?.code);
 return [1, 2, 4, 17, 23, 32, 613, 80004].includes(code) || code >= 500 && code <= 599 || ['ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'ENOTFOUND'].includes(error?.code);
}

/** @param {string | number | undefined} cutoff @param {string | number} activity @param {string | null} [requestedAt] */
export function sourceCoversRefresh(cutoff, activity, requestedAt = null) {
 const time = value => typeof value === 'number' ? value : Date.parse(value);
 const end = time(cutoff), latest = time(activity), requested = requestedAt ? time(requestedAt) : null;
 return Number.isFinite(end) && Number.isFinite(latest) && end >= latest &&
  (requested == null || Number.isFinite(requested) && end >= requested);
}

export function mergeConversationRows(existing, incoming) {
 const rows = new Map(existing.map(row => [row.id, row]));
 for (const row of incoming) {
  if (!row.id) throw Error('Conversation is missing its identifier');
  const previous = rows.get(row.id);
  if (!previous || !Number.isFinite(Date.parse(previous.updated_time)) || Date.parse(row.updated_time) >= Date.parse(previous.updated_time)) rows.set(row.id, { ...previous, ...row });
 }
 return [...rows.values()];
}
