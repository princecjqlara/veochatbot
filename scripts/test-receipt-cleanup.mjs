import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Vercel sets NODE_ENV=production. React's test renderer needs the test build;
// scope this override to the child so the subsequent app build stays production.
const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run',
    'src/lib/__tests__/veo-delivered-photo-cleanup.test.ts',
    'src/lib/__tests__/veo-photo-cleanup.test.ts', 'src/lib/__tests__/veo-reviewed-delivery.test.ts',
    'src/app/api/cron/receipt-photos/route.test.ts',
    'src/app/api/cron/workspace/route.test.ts',
    'src/lib/__tests__/temporary-background-pause.test.ts',
    'src/components/VeoDealEvidenceInbox.test.ts',
    'src/lib/__tests__/veo-deal-review-sql.test.ts',
    '--maxWorkers=1', '--minWorkers=1'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } });
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
