import { describe, expect, it } from 'vitest';
import { backfillCoverageComplete, conversationIndex, databaseRetryDelay, retryableSourceError, sourceCoverageComplete } from '../../../scripts/lib/lead-source-coverage.mjs';
const page = { id: 'p', fb_page_id: '100', name: 'Sample Page' };
describe('full historical source coverage', () => {
 it('resumes an interrupted inbox at its saved cursor and preserves its source date', () => {
  const old = { page_id: 'p', fb_page_id: '100', started_at: '2026-11-01T00:00:00Z', complete: false, next: '100/conversations?after=saved', conversations: [{ id: 'thread' }], error: { code: 23 } };
  const resumed = conversationIndex(page, old);
  expect(resumed.next).toBe(old.next); expect(resumed.started_at).toBe(old.started_at); expect(resumed.conversations).toEqual(old.conversations); expect(resumed.error).toBeUndefined();
  expect(old.error).toEqual({ code: 23 });
  expect(conversationIndex({ ...page, fb_page_id: 'other' }, old).conversations).toEqual([]);
 });
 it('never treats missing Pages, duplicate Page rows, or failed individual histories as complete', () => {
  expect(sourceCoverageComplete([{ page_id: 'p', complete: true }], [], 2)).toBe(false);
  expect(sourceCoverageComplete([{ page_id: 'p', complete: true }, { page_id: 'p', complete: true }], [], 2)).toBe(false);
  expect(sourceCoverageComplete([{ page_id: 'p', complete: true }], [{ code: 404 }], 1)).toBe(false);
  expect(sourceCoverageComplete([{ page_id: 'p', complete: false, skipped: 'No index' }], [], 1)).toBe(false);
  expect(sourceCoverageComplete([{ page_id: 'p', complete: true, error: { code: 190 } }], [], 1)).toBe(false);
  expect(sourceCoverageComplete([], [], undefined)).toBe(false);
 });
 it('requires both finished inventories and histories for the same complete Page set', () => {
  const receipt = { passed: true, coverage_complete: true, completed_at: '2026-11-02T00:00:00Z', expected_pages: 1, pages: [{ page_id: 'p', complete: true, index_started_at: '2026-11-01T00:00:00Z' }], errors: [] };
  expect(backfillCoverageComplete(receipt, receipt)).toBe(true);
  expect(backfillCoverageComplete(receipt, { ...receipt, passed: false })).toBe(false);
  expect(backfillCoverageComplete(receipt, { ...receipt, pages: [{ page_id: 'other', complete: true }] })).toBe(false);
  expect(backfillCoverageComplete(receipt, { ...receipt, errors: [{ code: 404 }] })).toBe(false);
  expect(backfillCoverageComplete(receipt, { ...receipt, completed_at: null })).toBe(false);
  expect(backfillCoverageComplete(receipt, { ...receipt, completed_at: '2026-11-01T23:00:00Z' })).toBe(false);
  expect(backfillCoverageComplete(receipt, { ...receipt, pages: [{ ...receipt.pages[0], index_started_at: '2026-10-31T00:00:00Z' }] })).toBe(false);
 });
 it('respects pooler cooldowns and bounds repeated outage probes', () => {
  expect(databaseRetryDelay(new Error('(ECIRCUITBREAKER) temporarily blocked'), 1)).toBeGreaterThanOrEqual(150000);
  expect(databaseRetryDelay(new Error('temporarily unavailable'), 1)).toBe(30000);
  expect(databaseRetryDelay(new Error('temporarily unavailable'), 20)).toBe(300000);
 });
 it('retries transient source failures while keeping permission and invalid-input gaps explicit', () => {
  for (const code of [23, 503, 4, 'ETIMEDOUT']) expect(retryableSourceError({ code })).toBe(true);
  for (const code of [190, 200, 100, 404]) expect(retryableSourceError({ code })).toBe(false);
  expect(retryableSourceError(undefined)).toBe(false);
 });
});
