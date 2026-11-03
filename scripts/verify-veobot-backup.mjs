import fs from 'node:fs';
import path from 'node:path';
import { verifyMigrationBackup } from './lib/migration-data.mjs';
const dir=path.resolve('.vercel/database-migration');
const explicit=process.argv.find(arg=>arg.startsWith('--manifest='))?.slice(11);
const manifest=explicit||JSON.parse(fs.readFileSync(path.join(dir,'latest-account-backup.json'),'utf8')).manifest;
const report=await verifyMigrationBackup(manifest);
fs.writeFileSync(path.join(path.dirname(path.resolve(manifest)),'verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,run_id:report.run_id,pages:report.pages,tables:report.tables.length,rows:report.tables.reduce((n,t)=>n+t.rows,0),dependency_gaps:report.dependency_gaps?.length,import_scope_approval_pending:report.import_scope_approval_pending}));
