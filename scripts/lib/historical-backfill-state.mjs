import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function supervisorOwnsLock(metadata, lockTime) {
 return metadata?.is_supervisor === true && Number.isFinite(Date.parse(metadata.created_at)) && Date.parse(metadata.created_at) <= lockTime;
}

export function runningHistoricalSupervisor(pid, lockFile) {
 if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid supervisor lock owner');
 try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
 if (process.platform === 'win32') {
  // Windows quickly reuses process IDs; a live PID alone is not lock ownership.
  const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "'; if($p){[PSCustomObject]@{is_supervisor=($p.Name -eq 'node.exe' -and $p.CommandLine -match 'run-deterministic-lead-backfill\\.mjs');created_at=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}";
  const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  return value ? supervisorOwnsLock(JSON.parse(value), fs.statSync(lockFile).mtimeMs) : false;
 }
 // A reused process with a different command must not block a saved checkpoint.
 const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 10000 });
 return /run-deterministic-lead-backfill\.mjs(?:\s|$)/.test(args);
}

// Inspect a checkpoint before any new audit can overwrite its manifest.
export function pendingHistoricalRepair(dir) {
 const file = path.join(dir, 'repair-apply.json');
 if (!fs.existsSync(file)) return false;
 const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
 if (!receipt.applied || receipt.passed) return false;
 const manifest = fs.readFileSync(path.join(dir, 'manifest.jsonl'), 'utf8');
 const hash = crypto.createHash('sha256').update(manifest).digest('hex');
 if (receipt.manifest_sha256 !== hash) throw Error('Pending repair manifest changed; preserve the checkpoint for review');
 return true;
}
