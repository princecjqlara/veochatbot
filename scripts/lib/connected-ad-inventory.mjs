export function connectedAdInventory(ads, allowedPages, accountId, pageOf, metadata) {
 if (!Array.isArray(ads)) throw Error('Ad inventory is incomplete');
 const records = [], owners = new Map();
 for (const ad of ads) {
  const pageId = allowedPages.get(pageOf(ad));
  if (!pageId || typeof ad.id !== 'string' || !/^\d+$/.test(ad.id)) continue;
  if (String(ad.account_id) !== accountId.replace(/^act_/, '')) throw Error('Ad inventory includes another account');
  records.push(metadata(ad, pageId)); owners.set(ad.id, pageId);
 }
 return { records, owners };
}

export function currentAdRefreshReceipt(receipt, jobId, exitCode) {
 return exitCode === 0 && receipt?.refresh_job_id === jobId && receipt.scope === 'connected_pages';
}

export function adRefreshCoversPages(receipt, pageIds) {
 const actual = (receipt?.connected_pages || []).map(page => page.page_id);
 const expected = new Set(pageIds);
 return actual.length === expected.size && new Set(actual).size === expected.size && actual.every(id => expected.has(id));
}
