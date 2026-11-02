export async function connectedPageScope(candidates, probe) {
 const result = { connected: [], excluded: [], unverified: [] };
 for (const page of candidates) {
  if (!page.access_token) { result.excluded.push({ page_id: page.id, page: page.name, code: 'NO_PAGE_TOKEN' }); continue; }
  try {
   const proof = await probe(page);
   if (!Array.isArray(proof?.data)) throw Error('Page connection could not be verified');
   result.connected.push(page);
  } catch (error) {
   const value = { page_id: page.id, page: page.name, error: { code: error.code || null } };
   if ([190, 200].includes(error.code)) result.excluded.push(value);
   else result.unverified.push(value);
  }
 }
 return result;
}
