import { describe, expect, it, vi } from 'vitest';
import { VEO_TARGET_PROJECT } from '../../../scripts/lib/database-migration-safety.mjs';
import { migrationRetryDelay, migrationCheckpointMatches, migrationConnectionOptions, migrationInputsHash, migrationStageState, probeMigrationDatabase, migrationProcessOwnsLock, installedMigrationPlanMatches } from '../../../scripts/lib/migration-retry.mjs';
describe('migration timeout recovery', () => {
 it('resumes a committed schema checkpoint only when every database fingerprint matches', () => {
  const plan = [{ name: 'baseline.sql', sha256: 'hash' }], rows = [{ filename: 'baseline.sql', sha256: 'hash', project_ref: VEO_TARGET_PROJECT }];
  expect(installedMigrationPlanMatches(rows, plan, VEO_TARGET_PROJECT)).toBe(true);
  expect(installedMigrationPlanMatches([], plan, VEO_TARGET_PROJECT)).toBe(false);
  expect(installedMigrationPlanMatches([{ ...rows[0], sha256: 'changed' }], plan, VEO_TARGET_PROJECT)).toBe(false);
  expect(installedMigrationPlanMatches([{ ...rows[0], project_ref: 'wrong' }], plan, VEO_TARGET_PROJECT)).toBe(false);
 });
 it('backs off repeated timeouts and preserves the pooler circuit-breaker cooldown', () => {
  expect([1, 2, 3, 4, 5, 6].map(attempt => migrationRetryDelay({ code: 'ETIMEDOUT' }, attempt))).toEqual([30000, 60000, 120000, 240000, 300000, 300000]);
  expect(migrationRetryDelay({ message: 'ECIRCUITBREAKER: retry later' }, 1)).toBe(150000);
  expect(migrationRetryDelay({ code: 'ENETUNREACH' }, 1)).toBe(300000);
  expect(migrationRetryDelay({ code: '28P01' }, 1)).toBe(300000);
 });
 it('never reuses a stale preflight or assumes a passing dry-run committed the schema', () => {
  const expected = { runId: 'current', project: VEO_TARGET_PROJECT, mode: 'apply', manifestHash: 'hash', startedAt: Date.parse('2026-11-03T00:00:00Z') };
  const receipt = { passed: true, applied: true, run_id: 'current', target_project: VEO_TARGET_PROJECT, mode: 'apply', manifest_sha256: 'hash', started_at: '2026-11-03T00:00:01Z', completed_at: '2026-11-03T00:00:02Z' };
  expect(migrationCheckpointMatches(receipt, expected)).toBe(true);
  for (const patch of [{ run_id: 'old' }, { applied: false }, { mode: 'preflight' }, { manifest_sha256: 'changed' }, { target_project: 'wrong' }, { completed_at: '2026-11-02T00:00:00Z' }, { started_at: 'invalid' }])
   expect(migrationCheckpointMatches({ ...receipt, ...patch }, expected)).toBe(false);
 });
 it('uses the actual IPv6 DNS answer without mistaking the project for a nonexistent hostname', async () => {
  const resolver = { resolve4: vi.fn().mockRejectedValue({ code: 'ENODATA' }), resolve6: vi.fn().mockResolvedValue(['2001:db8::1']) };
  const options = await migrationConnectionOptions('postgresql://postgres:example@db.' + VEO_TARGET_PROJECT + '.supabase.co:5432/postgres', resolver);
  expect(options).toMatchObject({ host: '2001:db8::1', user: 'postgres', database: 'postgres', ssl: { servername: 'db.' + VEO_TARGET_PROJECT + '.supabase.co' } });
  expect(resolver.resolve6).toHaveBeenCalledTimes(1);
 });
 it('only checks the database in a read-only transaction and closes the connection on failure', async () => {
  const claim = (role: string) => 'header.' + Buffer.from(JSON.stringify({ ref: VEO_TARGET_PROJECT, role })).toString('base64url') + '.signature';
  const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://' + VEO_TARGET_PROJECT + '.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: claim('anon'), SUPABASE_SERVICE_ROLE_KEY: claim('service_role'),
   DATABASE_POOLER_URL_5432: 'postgresql://postgres.' + VEO_TARGET_PROJECT + ':example@aws-1-ap-south-1.pooler.supabase.com:5432/postgres' };
  const client = { on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn().mockResolvedValue(undefined) };
  expect(await probeMigrationDatabase(env, VEO_TARGET_PROJECT, () => client)).toMatchObject({ ok: true, project: VEO_TARGET_PROJECT });
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN READ ONLY', 'SELECT 1', 'ROLLBACK']);
  const factory = vi.fn(() => client);
  await probeMigrationDatabase(env, VEO_TARGET_PROJECT, factory, 30000);
  expect(factory).toHaveBeenCalledWith(expect.objectContaining({ connectionTimeoutMillis: 30000, query_timeout: 6000 }));
  client.connect.mockRejectedValueOnce(Object.assign(Error('timeout expired'), { code: 'ETIMEDOUT' }));
  await expect(probeMigrationDatabase(env, VEO_TARGET_PROJECT, () => client)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  expect(client.end).toHaveBeenCalledTimes(3);
  await expect(probeMigrationDatabase(env, VEO_TARGET_PROJECT, factory, 600000)).rejects.toThrow('Invalid migration connection wait');
 });
 it('does not equate restored connectivity with an exported/imported data set or production cutover', () => {
  expect(migrationStageState({ ok: true }, { ok: true }, false)).toBe('preparing_destination_schema');
  expect(migrationStageState({ ok: true }, { ok: true }, true)).toBe('database_access_restored_export_pending');
  expect(migrationStageState({ ok: false }, { ok: true }, true)).toBe('destination_ready_waiting_for_source');
  expect(migrationStageState({ ok: true }, { ok: false, code: 'ENETUNREACH' }, false)).toBe('destination_requires_ipv4_pooler');
 });
 it('detects changed connection settings and Windows PID reuse', () => {
  expect(migrationInputsHash('source', 'target')).not.toBe(migrationInputsHash('source', 'new target'));
  const time = Date.parse('2026-11-03T00:00:00Z');
  expect(migrationProcessOwnsLock({ expected: true, created_at: '2026-11-02T23:59:00Z' }, time)).toBe(true);
  expect(migrationProcessOwnsLock({ expected: true, created_at: '2026-11-03T01:00:00Z' }, time)).toBe(false);
  expect(migrationProcessOwnsLock({ expected: false, created_at: '2026-11-02T23:59:00Z' }, time)).toBe(false);
 });
});
