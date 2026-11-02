// Archive identifiers never establish a live contact ID. Publication resolves
// each source by the currently authorized Page and the customer's PSID.
export function calendarRegistryEntries(rows, pages, connectedIds) {
 const allowed = new Set(connectedIds), byId = new Map(pages.map(page => [page.id, page])), latest = new Map();
 for (const row of rows) {
  if (!allowed.has(row.page_id)) continue;
  const page = byId.get(row.page_id);
  if (!page || page.fb_page_id !== row.fb_page_id || !/^\d+$/.test(row.psid || '') || !row.complete ||
   !Number.isFinite(Date.parse(row.source_cutoff_at)) || !/^[0-9a-f]{64}$/.test(row.archive_sha256 || '') || typeof row.archive_path !== 'string') throw Error('Calendar source registry identity or fingerprint is invalid');
  const key = page.id + ':' + row.psid, previous = latest.get(key);
  if (previous && previous.cutoff === row.source_cutoff_at && previous.hash !== row.archive_sha256) throw Error('Conflicting sources share the same calendar cutoff');
  if (!previous || Date.parse(row.source_cutoff_at) > Date.parse(previous.cutoff)) latest.set(key, {
   page, psid: row.psid, file: row.archive_path, cutoff: row.source_cutoff_at, hash: row.archive_sha256, sourceKind: row.source_kind === 'live_graph' ? 'live_graph' : 'audited_history', explicitFull: true
  });
 }
 return [...latest.values()];
}

export const markRetainedCalendarCacheSql = `UPDATE contact_conversion_cache f SET source_kind='audited_history'
 FROM repair_input r JOIN repair_before b ON b.id=r.contact_id
 WHERE f.contact_id=r.contact_id AND f.page_id=r.page_id AND r.projection_cache->>'source_kind'='audited_history'
 AND f.source_cutoff_at=(r.projection_cache->>'source_cutoff_at')::timestamptz
 AND (b.conversion_cache IS NULL OR b.conversion_cache->>'source_kind'='audited_history'
  OR (b.conversion_cache->>'source_cutoff_at')::timestamptz<f.source_cutoff_at)`;
