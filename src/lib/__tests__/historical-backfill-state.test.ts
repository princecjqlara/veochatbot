import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pendingHistoricalRepair, supervisorOwnsLock } from '../../../scripts/lib/historical-backfill-state.mjs';
describe('historical repair checkpoint protection', () => {
 it('does not confuse a reused Windows PID with the original supervisor', () => {
  const lockedAt = Date.parse('2026-11-02T16:00:00Z');
  expect(supervisorOwnsLock({ is_supervisor: true, created_at: '2026-11-02T15:59:00Z' }, lockedAt)).toBe(true);
  expect(supervisorOwnsLock({ is_supervisor: false, created_at: '2026-11-02T15:59:00Z' }, lockedAt)).toBe(false);
  expect(supervisorOwnsLock({ is_supervisor: true, created_at: '2026-11-02T17:00:00Z' }, lockedAt)).toBe(false);
  expect(supervisorOwnsLock(null, lockedAt)).toBe(false);
 });
 it('requires resuming the same manifest before a new audit can replace it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veobot-checkpoint-'));
  try {
   expect(pendingHistoricalRepair(dir)).toBe(false);
   const manifest = '{"contact_id":"sample"}\n';
   fs.writeFileSync(path.join(dir, 'manifest.jsonl'), manifest);
   const receipt = { applied: true, passed: false, manifest_sha256: crypto.createHash('sha256').update(manifest).digest('hex') };
   fs.writeFileSync(path.join(dir, 'repair-apply.json'), JSON.stringify(receipt));
   expect(pendingHistoricalRepair(dir)).toBe(true);
   fs.writeFileSync(path.join(dir, 'manifest.jsonl'), 'changed');
   expect(() => pendingHistoricalRepair(dir)).toThrow('manifest changed');
   fs.writeFileSync(path.join(dir, 'repair-apply.json'), JSON.stringify({ ...receipt, passed: true }));
   expect(pendingHistoricalRepair(dir)).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
 });
});
