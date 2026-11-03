// Retry the authorized migration prerequisites without writing to the source.
// This worker prepares the destination and saves a source-ownership inventory.
// Data copy and cutover remain explicit, unfulfilled checkpoints until verified.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { LEGACY_SOURCE_PROJECT, VEO_TARGET_PROJECT, assertProjectCredentials, schemaMigrationPlan, digest } from './lib/database-migration-safety.mjs';
import { migrationRetryDelay, migrationProcessOwnsLock, migrationCheckpointMatches, migrationInputsHash, probeMigrationDatabase, migrationStageState, migrationSchemaIsInstalled } from './lib/migration-retry.mjs';

const dir = path.resolve('.vercel/database-migration'); fs.mkdirSync(dir, { recursive: true });
const sourceFile = path.join(dir, 'source-production.env.local'), targetFile = path.resolve('.vercel/veobot-intended-project.env.local');
const progressFile = path.join(dir, 'progress.json'), lockFile = path.join(dir, 'retry.lock');
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const authorization = read(progressFile);
if (!authorization?.authorization_confirmed || authorization.source_project !== LEGACY_SOURCE_PROJECT || authorization.target_project !== VEO_TARGET_PROJECT || !authorization.preserve_existing_veobot_data)
 throw Error('The preserved-data migration authorization does not match these projects');
if (fs.existsSync(lockFile)) {
 const old = read(lockFile); if (!Number.isSafeInteger(old.pid) || old.pid <= 0) throw Error('Invalid migration retry lock');
 let active = false; try { process.kill(old.pid, 0); active = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
 if (active && process.platform === 'win32') {
  const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + old.pid + "';if($p){[PSCustomObject]@{expected=($p.Name -eq 'node.exe' -and $p.CommandLine -match 'run-veobot-migration-retries\\.mjs');created_at=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}";
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  active = Boolean(result) && migrationProcessOwnsLock(JSON.parse(result), fs.statSync(lockFile).mtimeMs);
 } else if (active) active = /run-veobot-migration-retries\.mjs(?:\s|$)/.test(execFileSync('ps', ['-p', String(old.pid), '-o', 'args='], { encoding: 'utf8', timeout: 10000 }));
 if (active) throw Error('The migration retry worker is already running');
 fs.unlinkSync(lockFile);
}
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
process.once('exit', () => { try { if (read(lockFile)?.pid === process.pid) fs.unlinkSync(lockFile); } catch {} });
const priorState = read(path.join(dir, 'retry-status.json'));
const priorCount = key => Number.isSafeInteger(priorState?.[key]) && priorState[key] >= 0 ? priorState[key] : 0;
const state = { pid: process.pid, started_at: new Date().toISOString(), status: 'starting', source_project: LEGACY_SOURCE_PROJECT, target_project: VEO_TARGET_PROJECT,
 attempts: priorCount('attempts'), source_attempts: priorCount('source_attempts'), destination_attempts: priorCount('destination_attempts'), schema_ready: false, source_database_writes: 0, openrouter_calls: 0, customer_messages_sent: 0, production_cutover_completed: false };
const atomic = (file, value) => { const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); };
const flush = () => {
 const now = new Date().toISOString();
 const progress = read(progressFile), blockers = [];
 const accountBackup=read(path.join(dir,'account-backup-status.json'));
 const importCheckpoint=read(path.join(dir,'account-import-checkpoints.json'));
 if(importCheckpoint?.stage==='core_verified_storage_pending'&&state.status==='database_access_restored_export_pending')state.status='destination_storage_capacity_pending';
 atomic(path.join(dir,'retry-status.json'),{...state,updated_at:now});
 const chatbotBackup=read(path.join(dir,'latest-chatbot-backup.json'));
 const chatbotVerification=chatbotBackup?.manifest?read(path.join(path.dirname(path.resolve(chatbotBackup.manifest)),'verification.json')):null;
 const chatbotPreserved=chatbotVerification?.passed===true&&chatbotVerification.run_id===chatbotBackup.run_id&&chatbotVerification.backup_kind==='chatbot';
 if (!state.source_access?.ok) blockers.push('The source database is unavailable; consistent source export is pending automatic retries.');
 if (!state.destination_access?.ok) blockers.push(state.destination_access?.code === 'ENETUNREACH' ? 'The destination requires a working IPv4 pooler or IPv6 route.' : 'Destination access is pending automatic retries.');
 if (state.source_inventory && !state.source_inventory.passed) blockers.push('VeoBot Page ownership needs verification before data copy.');
 if(importCheckpoint?.stage==='core_verified_storage_pending')blockers.push('Core records are verified; the two large history tables require more destination disk capacity before cutover.');
 atomic(progressFile, { ...progress, status: state.status, retry_worker_pid: process.pid,
  retry_worker_active: state.status !== 'retry_worker_interrupted', retry_next_at: state.next_retry_at || null, retry_attempts: state.attempts, updated_at: now,
  remote_schema_installed: state.schema_ready || progress.remote_schema_installed, preflight_remote_completed: state.schema_ready || progress.preflight_remote_completed,
  source_database_writes: 0, blockers,
  account_backup_status:accountBackup?.status||'pending',account_backup_run_id:accountBackup?.run_id||null,
  destination_core_import_verified:importCheckpoint?.passed===true&&importCheckpoint?.applied===true,
  destination_baseline_import_complete:importCheckpoint?.baseline_complete===true,
  deferred_history_tables:importCheckpoint?.deferred_tables||[],
  chatbot_setup_backup_verified:chatbotPreserved,chatbot_setup_backup_run_id:chatbotPreserved?chatbotBackup.run_id:null,
  next_action: !state.source_access?.ok ? 'Retry source access; retain saved snapshots and current production settings.' :
   !state.schema_ready ? 'Finish destination provisioning before importing records.' :
   importCheckpoint?.stage==='core_verified_storage_pending'?'Increase destination storage, resume the verified history checkpoints, then capture final changes and verify cutover.':
   'Finish the consistent account backup and matching Page import scope, then copy and verify all data before production cutover.' });
};
const cleanError = error => ({ ok: false, code: error.code || (/timeout|timed out/i.test(error.message || '') ? 'ETIMEDOUT' : error.name),
 message: String(error.message || 'Unavailable').replace(/postgres(?:ql)?:\/\/\S+|Bearer\s+\S+|eyJ[\w.-]+|EA[\w-]{25,}/g, '[redacted]').slice(0, 300) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function stageEnvironment(env) {
 const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NEXT_PUBLIC_SUPABASE_|SUPABASE_|DATABASE_|POSTGRES_)/.test(key)));
 return { ...inherited, ...env };
}
async function command(script, args, env) {
 const log = fs.openSync(path.join(dir, 'retry-worker.log'), 'a');
 try { return await new Promise(resolve => {
  const child = spawn(process.execPath, ['scripts/' + script, ...args], { env: stageEnvironment(env), windowsHide: true, stdio: ['ignore', log, log] });
  child.once('error', error => resolve({ code: 1, error: error.message })); child.once('exit', code => resolve({ code }));
 }); } finally { fs.closeSync(log); }
}
const outcomes = { source: { last: null, next: 0, failures: 0 }, target: { last: null, next: 0, failures: 0 } };
let priorInputs = null, priorManifest = null, capturedSource = false;
try {
 for (;;) {
  try {
   const sourceBytes = fs.readFileSync(sourceFile), targetBytes = fs.readFileSync(targetFile), inputs = migrationInputsHash(sourceBytes, targetBytes);
   const sourceEnv = parseEnv(sourceBytes.toString('utf8')), targetEnv = parseEnv(targetBytes.toString('utf8'));
   try { assertProjectCredentials(sourceEnv, LEGACY_SOURCE_PROJECT); assertProjectCredentials(targetEnv, VEO_TARGET_PROJECT); }
   catch (error) { throw Object.assign(error, { code: 'PROJECT_CONFIG' }); }
   const plan = schemaMigrationPlan(), manifest = digest(JSON.stringify(plan.map(({ name, sha256 }) => ({ name, sha256 }))));
   if (inputs !== priorInputs || manifest !== priorManifest) {
    const resumedSourceFailure = priorInputs === null && priorState?.source_access?.ok === false;
    for (const [key, outcome] of Object.entries(outcomes)) { outcome.next = 0; outcome.failures = key === 'source' && resumedSourceFailure ? Math.min(5, priorCount('source_attempts')) : 0; outcome.last = null; }
    state.schema_ready = false; priorInputs = inputs; priorManifest = manifest; capturedSource = false;
   }
   state.attempts++;
   await Promise.all([['source', sourceEnv, LEGACY_SOURCE_PROJECT], ['target', targetEnv, VEO_TARGET_PROJECT]].map(async ([key, env, project]) => {
    const outcome = outcomes[key]; if (Date.now() < outcome.next) return;
    state[key === 'source' ? 'source_attempts' : 'destination_attempts']++;
    const wait = key === 'source' && outcome.failures >= 2 ? 30000 : 6000;
    state[key === 'source' ? 'source_connection_wait_ms' : 'destination_connection_wait_ms'] = wait;
    try { outcome.last = await probeMigrationDatabase(env, project, undefined, wait); outcome.failures = 0; outcome.next = Date.now() + 300000; }
    catch (error) { outcome.last = { project, ...cleanError(error) }; outcome.next = Date.now() + migrationRetryDelay(error, ++outcome.failures); }
   }));
   state.source_access = outcomes.source.last; state.destination_access = outcomes.target.last;
   state.status = migrationStageState(outcomes.source.last, outcomes.target.last, state.schema_ready); flush();
   if (outcomes.target.last?.ok && !state.schema_ready) {
    const saved = read(path.join(dir, 'schema-apply.json'));
    if (saved?.run_id && migrationCheckpointMatches(saved, { runId: saved.run_id, project: VEO_TARGET_PROJECT, mode: 'apply', manifestHash: manifest, startedAt: Date.parse(saved.started_at) }) &&
     await migrationSchemaIsInstalled(targetEnv, VEO_TARGET_PROJECT, plan)) { state.schema_ready = true; state.schema_checkpoint_reused = true; }
   }
   if (outcomes.target.last?.ok && !state.schema_ready && Date.now() >= (state.schema_retry_after || 0)) {
    for (const mode of ['preflight', 'apply']) {
     const runId = randomUUID(), startedAt = Date.now(); state.status = 'destination_schema_' + mode; flush();
     const result = await command('provision-veobot-database.mjs', ['--' + mode, '--target-project=' + VEO_TARGET_PROJECT, '--run-id=' + runId], targetEnv);
     const receipt = read(path.join(dir, 'schema-' + mode + '.json'));
     if (result.code !== 0 || !migrationCheckpointMatches(receipt, { runId, project: VEO_TARGET_PROJECT, mode, manifestHash: manifest, startedAt }))
      throw Object.assign(Error(receipt?.error || result.error || 'Schema receipt did not match its retry attempt'), { code: receipt?.code || 'SCHEMA_REVIEW' });
    }
    state.schema_ready = true; delete state.schema_error; delete state.schema_retry_after;
   }
   if (outcomes.source.last?.ok && !capturedSource && Date.now() >= (state.source_inventory_retry_after || 0)) {
    state.status = 'verifying_source_page_ownership'; flush();
    const runId = randomUUID(), startedAt = Date.now(), result = await command('inspect-veobot-migration-source.mjs', ['--run-id=' + runId], sourceEnv);
    const receipt = read(path.join(dir, 'source-inventory.json'));
    state.source_inventory = { passed: result.code === 0 && receipt?.passed === true && receipt.run_id === runId && Date.parse(receipt.started_at) >= startedAt,
     eligible_pages: receipt?.eligible_pages?.length || 0, ownership_gaps: receipt?.ownership_gaps?.length || 0, error: receipt?.error || null };
    capturedSource = state.source_inventory.passed;
    state.source_inventory_retry_after = Date.now() + 300000;
   }
   state.status = migrationStageState(outcomes.source.last, outcomes.target.last, state.schema_ready);
   if (state.source_inventory && !state.source_inventory.passed && outcomes.source.last?.ok) state.status = 'source_ownership_verification_pending';
   state.next_retry_at = new Date(Math.min(outcomes.source.next, outcomes.target.next)).toISOString(); flush();
  } catch (error) {
   state.status = error.code === 'PROJECT_CONFIG' ? 'migration_configuration_needs_review' : 'migration_retry_pending'; state.schema_error = cleanError(error);
   state.schema_retry_after = Date.now() + 300000; state.next_retry_at = new Date(state.schema_retry_after).toISOString(); flush();
  }
  // Wake often enough to notice a newly supplied pooler URL, while connection
  // attempts themselves keep the per-endpoint exponential cooldown above.
  await sleep(15000);
 }
} catch (error) { state.status = 'retry_worker_interrupted'; state.error = cleanError(error); flush(); process.exitCode = 1; }
