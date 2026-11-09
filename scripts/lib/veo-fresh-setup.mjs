import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { digest } from './database-migration-safety.mjs';

export const freshSetupTables = ['businesses','pages','chatbot_configs','chatbot_knowledge_documents','chatbot_knowledge_chunks',
    'chatbot_drive_folders','chatbot_drive_files','chatbot_media_assets','chatbot_pricing_experiments','chatbot_pricing_packages',
    'tags','welcome_messages','workflow_automations','ad_tracking_settings'];
export const canonicalValue = value => Array.isArray(value) ? value.map(canonicalValue) : value && typeof value==='object'
    ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalValue(value[key])])) : value;
export function readVerifiedSetup(directory) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'retained-manifest.json'), 'utf8'));
    if (manifest.target_project !== 'vhtbmdizugnxkgocmruq') throw Error('Unexpected setup backup project');
    const rows = {};
    for (const name of [...freshSetupTables, 'users']) {
        const item = manifest.retained.find(t => t.name === name);
        if (!item || item.file !== name + '.jsonl.gz') throw Error('Required setup artifact missing: ' + name);
        const bytes = gunzipSync(fs.readFileSync(path.join(directory, item.file)));
        if (digest(bytes) !== item.sha256) throw Error('Setup backup checksum differs: ' + name);
        rows[name] = bytes.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        if (rows[name].length !== item.rows) throw Error('Setup backup row count differs: ' + name);
    }
    if (rows.chatbot_configs.some(c => c.trial_contact_id)) throw Error('Setup references historical trial contacts');
    return { manifest, rows };
}

export function validateRecoveryRoster(workspace, ownerId) {
    if (!workspace?.tenant_id || !Array.isArray(workspace.accounts) || !workspace.accounts.length || !Array.isArray(workspace.pages)) throw Error('Verified account directory required');
    const accounts = workspace.accounts, byId = new Map(accounts.map(a => [a.user_id, a]));
    if (byId.size !== accounts.length || accounts.filter(a => a.role === 'owner').length !== 1 || byId.get(ownerId)?.role !== 'owner') throw Error('Expected retained owner and distinct identities');
    const pages = new Set(workspace.pages.map(p => p.id));
    for (const a of accounts) {
        if (!a.name || !['owner','team_leader','manager','member'].includes(a.role) || !Array.isArray(a.page_ids) || a.page_ids.some(p => !pages.has(p))) throw Error('Invalid saved role or Page grant');
        if (a.role === 'owner' ? a.parent_id !== null : !byId.has(a.parent_id)) throw Error('Missing saved supervisor');
        let current = a; const visited = new Set();
        while (current) {
            if (visited.has(current.user_id)) throw Error('Saved account hierarchy contains a cycle');
            visited.add(current.user_id); current = byId.get(current.parent_id);
        }
    }
    const sorted = [], pending = new Set(accounts);
    while (pending.size) {
        const next = [...pending].filter(a => a.parent_id === null || sorted.some(p => p.user_id === a.parent_id));
        if (!next.length) throw Error('Saved account hierarchy cannot be ordered');
        sorted.push(...next); for (const a of next) pending.delete(a);
    }
    return sorted;
}
