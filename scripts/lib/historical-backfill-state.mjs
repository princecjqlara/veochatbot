import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
