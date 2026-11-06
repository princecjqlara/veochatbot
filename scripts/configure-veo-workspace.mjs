// Values travel to Vercel over stdin. Never log the shared handoff secret.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const appRoot = process.cwd(), jaucianRoot = path.resolve(appRoot, '../../SENIOR MANAGER');
const cliPackage = path.join(process.env.APPDATA, 'npm/node_modules/vercel');
const cliManifest = JSON.parse(fs.readFileSync(path.join(cliPackage, 'package.json'), 'utf8'));
const cli = path.join(cliPackage, typeof cliManifest.bin === 'string' ? cliManifest.bin : cliManifest.bin.vercel);
function set(root, name, value) {
    if (!value) throw new Error(`Missing ${name}`);
    const result = spawnSync(process.execPath, [cli, 'env', 'add', name, 'production', '--force'], {
        cwd: root, input: value, encoding: 'utf8', windowsHide: true, timeout: 120000
    });
    if (result.status !== 0) throw new Error(`Could not configure ${name} on ${root === appRoot ? 'VEO' : 'Jaucian'}`);
    console.log(JSON.stringify({ configured: name, service: root === appRoot ? 'VEO' : 'Jaucian' }));
}
if (process.argv.includes('--prepare')) {
    const publicUrl = process.env.VEO_WORKSPACE_PUBLIC_URL;
    if (!publicUrl?.startsWith('https://')) throw new Error('Set the maintained application production URL');
    const source = fs.readFileSync(path.join(jaucianRoot, 'daily_automation.py'), 'utf8');
    const groups = source.slice(source.indexOf('GROUPS = {'), source.indexOf('TRABAWHO_CHAT_ID ='));
    const ids = [...groups.matchAll(/^    (-\d+): \{/gm)].map(m => m[1]);
    if (!ids.length) throw new Error('Could not resolve approved VEO groups');
    const secret = randomBytes(48).toString('base64url');
    set(appRoot, 'VEO_JAUCIAN_SECRET', secret);
    set(jaucianRoot, 'VEO_JAUCIAN_SECRET', secret);
    set(appRoot, 'VEO_JAUCIAN_URL', 'https://jaucianassitant.vercel.app');
    set(jaucianRoot, 'VEO_WORKSPACE_URL', publicUrl);
    set(appRoot, 'VEO_APPROVED_TELEGRAM_CHAT_IDS', ids.join(','));
    set(appRoot, 'VEO_WORKSPACE_ENABLED', 'false');
    set(jaucianRoot, 'VEO_WORKSPACE_ENABLED', 'false');
} else if (process.argv.includes('--enable')) {
    const receipt = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
    if (!receipt.launched || !receipt.id || !receipt.launch_at) throw new Error('Launch receipt required');
    set(jaucianRoot, 'VEO_WORKSPACE_TENANT_ID', receipt.id);
    set(jaucianRoot, 'VEO_WORKSPACE_LAUNCH_AT', receipt.launch_at);
    set(appRoot, 'VEO_WORKSPACE_ENABLED', 'true');
    set(jaucianRoot, 'VEO_WORKSPACE_ENABLED', 'true');
} else throw new Error('Choose --prepare or --enable');
