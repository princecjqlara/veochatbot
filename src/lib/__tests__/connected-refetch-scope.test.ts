import { describe, expect, it, vi } from 'vitest';
import { connectedPageScope } from '../../../scripts/lib/connected-pages.mjs';
import { adRefreshCoversPages, connectedAdInventory, currentAdRefreshReceipt } from '../../../scripts/lib/connected-ad-inventory.mjs';
import { catalogMetadata, creativePageId } from '../facebook-ad-catalog';
describe('connected Page refetch scope', () => {
 it('rejects stale successful ad receipts and mismatched connected Page coverage', () => {
  const receipt = { refresh_job_id: 'old', scope: 'connected_pages', complete: true, connected_pages: [{ page_id: 'p' }] };
  expect(currentAdRefreshReceipt(receipt, 'new', 0)).toBe(false); expect(currentAdRefreshReceipt(receipt, 'old', 1)).toBe(false);
  expect(currentAdRefreshReceipt(receipt, 'old', 0)).toBe(true);
  expect(adRefreshCoversPages(receipt, ['p'])).toBe(true); expect(adRefreshCoversPages(receipt, ['p', 'q'])).toBe(false);
 });
 it('includes connected Pages with zero stored contacts and excludes rejected or uncertain connections', async () => {
  const rows = [{ id: 'empty', access_token: 'a', contacts: 0 }, { id: 'rejected', access_token: 'b' }, { id: 'uncertain', access_token: 'c' }, { id: 'missing', access_token: null }];
  const probe = vi.fn(async (page: any) => { if (page.id === 'rejected') throw Object.assign(Error('Denied'), { code: 190 }); if (page.id === 'uncertain') throw Object.assign(Error('Temporary'), { code: 503 }); return { data: [] }; });
  const scope = await connectedPageScope(rows, probe);
  expect(scope.connected.map((page: any) => page.id)).toEqual(['empty']);
  expect(scope.excluded.map((page: any) => page.page_id)).toEqual(['rejected', 'missing']);
  expect(scope.unverified.map((page: any) => page.page_id)).toEqual(['uncertain']); expect(probe).toHaveBeenCalledTimes(3);
 });
 it('imports ads only when their creative proves ownership by a connected Page and the requested account', () => {
  const ad = (id: string, page: string, account_id = '22') => ({ id, account_id, name: 'Ad', creative: { object_story_spec: { page_id: page } } });
  const result = connectedAdInventory([ad('11', '100'), ad('12', '200')], new Map([['100', 'connected']]), 'act_22', creativePageId, catalogMetadata);
  expect(result.records).toHaveLength(1); expect(result.records[0]).toMatchObject({ page_id: 'connected', ad_id: '11' }); expect([...result.owners.keys()]).toEqual(['11']);
  expect(() => connectedAdInventory([ad('11', '100', 'other')], new Map([['100', 'connected']]), 'act_22', creativePageId, catalogMetadata)).toThrow('another account');
 });
});
