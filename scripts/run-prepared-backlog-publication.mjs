// Publish locally prepared profiles when data access returns. No model calls.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { databaseRetryDelay } from './lib/lead-source-coverage.mjs';

const dir = path.resolve('.vercel/backlog-analysis');
fs.mkdirSync(dir, { recursive: true });
const lockFile = path.join(dir, 'publication.lock');
if (fs.existsSync(lockFile)) {
 const previous = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
 if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw Error('Invalid publication lock');
 let active = false;
 try { process.kill(previous.pid, 0); active = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
 if (active && process.platform === 'win32') {
  const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + previous.pid + "'; if($p){[PSCustomObject]@{expected=($p.Name -eq 'node.exe' -and $p.CommandLine -match 'run-prepared-backlog-publication\\.mjs');created_at=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}";
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  const metadata = output ? JSON.parse(output) : null;
  active = metadata?.expected === true && Date.parse(metadata.created_at) <= fs.statSync(lockFile).mtimeMs;
 } else if (active) {
  active = /run-prepared-backlog-publication\.mjs(?:\s|$)/.test(execFileSync('ps', ['-p', String(previous.pid), '-o', 'args='], { encoding: 'utf8', timeout: 10000 }));
 }
 if (active) throw Error('Prepared profile publication is already running');
 fs.unlinkSync(lockFile);
}
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
process.once('exit', () => { try { if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid === process.pid) fs.unlinkSync(lockFile); } catch {} });
const status = { pid: process.pid, started_at: new Date().toISOString(), status: 'waiting_for_prepared_profiles', scope: 'connected_pages', published_this_run: 0, publication_passes: 0, openrouter_calls: 0, ai_jobs_queued: 0, customer_messages_sent: 0 };
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const flush = () => {
 const file = path.join(dir, 'publication-background-status.json'), tmp = file + '.' + process.pid + '.tmp';
 fs.writeFileSync(tmp, JSON.stringify({ ...status, updated_at: new Date().toISOString() }, null, 2)); fs.renameSync(tmp, file);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(mode, limit, expected = null) {
 const started = Date.now(), log = fs.openSync(path.join(dir, 'publication-background.log'), 'a');
 const result = await new Promise(resolve => {
  const child = spawn(process.execPath, ['scripts/publish-prepared-backlog.mjs', '--' + mode, '--limit=' + limit, ...(expected ? ['--expected-manifest=' + expected] : [])], { windowsHide: true, stdio: ['ignore', log, log] });
  child.once('error', error => resolve({ code: 1, error: error.message }));
  child.once('exit', code => resolve({ code }));
 });
 fs.closeSync(log);
 const receipt = read(path.join(dir, 'publish-' + mode + '.json'));
 if (result.code !== 0 || !receipt?.passed || Date.parse(receipt.started_at) < started) throw Error(receipt?.error || result.error || 'Profile publication needs review; saved sources are retained');
 return receipt;
}

let failures = 0, verifiedManifest = null;
try {
 for (;;) {
  const prepared = read(path.join(dir, 'status.json'));
  if (!['prepared_saved_sources', 'prepared_with_review_errors'].includes(prepared?.status)) {
   status.status = 'waiting_for_prepared_profiles'; flush(); await sleep(30000); continue;
  }
  try {
   if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error('Load production database credentials before publication');
   const response = await fetch(process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1/contacts?select=id&limit=0', {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }, signal: AbortSignal.timeout(10000)
   });
   if (!response.ok) throw Object.assign(Error('Database data API unavailable'), { code: (await response.json().catch(() => ({}))).code || 'HTTP_' + response.status });
  } catch (error) {
   const delay = databaseRetryDelay(error, ++failures); status.status = 'waiting_for_database'; status.database_error_code = error.name === 'TimeoutError' ? 'DATABASE_HEALTH_TIMEOUT' : error.code || error.name;
   status.next_retry_at = new Date(Date.now() + delay).toISOString(); flush(); await sleep(delay); continue;
  }
  delete status.database_error_code; delete status.next_retry_at;
  try {
   status.status = 'preflighting_prepared_profiles'; flush();
   const check = await run('preflight', 25);
   if (!verifiedManifest || verifiedManifest !== check.manifest_sha256) verifiedManifest = check.manifest_sha256;
   status.status = 'publishing_prepared_profiles'; flush();
   const receipt = await run('apply', 500, verifiedManifest);
   if (receipt.manifest_sha256 !== verifiedManifest) throw Error('Prepared manifest changed during publication; verify the replacement before continuing');
   failures = 0; delete status.error; delete status.next_retry_at;
   if(status.sweep_manifest !== receipt.manifest_sha256 || status.last_pass?.remaining_manifest_entries === 0){status.sweep_manifest=receipt.manifest_sha256;status.sweep_skipped={};}
   for(const [key,count] of Object.entries(receipt.skipped))status.sweep_skipped[key]=(status.sweep_skipped[key]||0)+count;
   status.publication_passes++; status.published_this_run += receipt.published; status.last_pass = receipt;
   const pendingSources = Object.entries(status.sweep_skipped).filter(([key]) => !['existing_review_retained', 'newer_profile_retained', 'already_published', 'no_customer_history'].includes(key)).reduce((sum, [, count]) => sum + count, 0);
   status.status = receipt.remaining_manifest_entries || pendingSources || receipt.unverified_pages?.length ? 'continuing_available_profiles' : 'prepared_manifest_pass_finished'; flush();
   // Revisit skipped sources after collectors have had time to import contacts
   // and when current Page connectivity changes. Never queue an AI review.
   await sleep(receipt.remaining_manifest_entries ? 15000 : 300000);
  } catch (error) {
   status.status = 'publication_retry_pending'; status.error = error.message; status.next_retry_at = new Date(Date.now() + 300000).toISOString(); flush();
   await sleep(300000);
  }
 }
} catch (error) { status.status = 'interrupted'; status.error = error.message; process.exitCode = 1; flush(); }
