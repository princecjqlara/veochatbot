import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
const directory = new URL('../../data/', import.meta.url);
const files = (await readdir(directory)).filter(name => /^commercial-intake-backup-.*\.json$/.test(name)).sort();
assert.ok(files.length, 'A pre-activation backup is required');
const backup = JSON.parse(await readFile(new URL(files.at(-1), directory), 'utf8'));
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const checked = response => { if (response.error) throw new Error(response.error.message); return response.data; };
const configs = checked(await db.from('chatbot_configs').select('*').in('page_id', backup.configs.map(config => config.page_id)));
const checks = [];
for (const original of backup.configs) {
    const current = configs.find(config => config.page_id === original.page_id);
    assert.equal(current.commercial_video_intake_enabled, true);
    assert.deepEqual(current.details_to_collect, ['Business Name', 'Business Location', 'Goal ng video', 'Contact Number']);
    assert.equal(current.details_completion_percent, 100);
    assert.equal(current.stop_when_details_collected, false);
    assert.equal(current.continuation_review_enabled, true);
    assert.equal(current.continuation_review_hour, 23);
    assert.equal(current.continuation_review_minute, 59);
    for (const key of ['enabled', 'follow_up_enabled', 'rag_enabled', 'knowledge_source_page_id', 'follow_up_quick_delays_minutes', 'follow_up_best_time_days']) {
        assert.deepEqual(current[key], original[key], `${original.name}: preserve ${key}`);
    }
    checks.push({ page: original.name.trim(), enabled: current.enabled, followUps: current.follow_up_enabled,
        knowledge: current.rag_enabled, passed: true });
}
const document = checked(await db.from('chatbot_knowledge_documents').select('status,chunk_count,content').eq('id', backup.document.id).single());
assert.equal(document.status, 'ready'); assert.ok(document.chunk_count > 0);
assert.ok(document.content.includes('Current owner-approved intake and free-offer update'));
const { count, error } = await db.from('chatbot_knowledge_documents').select('id', { count: 'exact', head: true }).eq('page_id', backup.document.page_id);
if (error) throw error;
assert.ok(count >= 478, 'Preserve the shared knowledge and media library');
const result = { at: new Date().toISOString(), pages: checks, knowledgeDocuments: count, updatedDocumentChunks: document.chunk_count,
    enabledPages: checks.filter(check => check.enabled).length, messagesSentByVerification: 0 };
await writeFile(new URL('concept-intake-production-readback.json', directory), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
