// Real-model and knowledge retrieval preview only. No Messenger or database writes.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { generateChatbotResponse } from '../src/lib/chatbot.ts';
import { containsCommercialVideoForm } from '../src/lib/chatbot-intake.ts';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
    { global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) }) } });
const checked = result => { if (result.error) throw new Error(result.error.message); return result.data; };
const configs = checked(await db.from('chatbot_configs').select('*').eq('commercial_video_intake_enabled', true));
assert.ok(configs.length, 'No commercial-video configs found');
const pages = checked(await db.from('pages').select('id,name,fb_page_id').in('id', configs.map(config => config.page_id)));
const page = pages.find(row => /Commercial sa Negosyo/i.test(row.name)) || pages[0];
const config = configs.find(row => row.page_id === page.id);
const before = configs.map(row => ({ page_id: row.page_id, enabled: row.enabled }));
const history = []; let details = {}; let request = {}; const turns = [];
for (const [index, text] of [
    'Hi po',
    'Bakery po ang business namin. Preview Bakery ang business name.',
    '24 seconds po',
    'Sige, gusto kong mag-proceed sa commercial video. Pakisend ng form.',
    'Manila po ang location namin. Goal ng video ay i-promote ang fresh bread. Contact number 09171234567.'
].entries()) {
    const created = new Date().toISOString();
    history.push({ id: 'preview-customer-' + index, from: { id: 'preview-only-customer', name: 'Miguel Reyes' }, message: text, created_time: created });
    const result = await generateChatbotResponse({ config, contactName: 'Miguel Reyes', pageName: page.name, pageId: page.fb_page_id,
        inboundMessage: text, history, collectedDetails: details, ...request });
    assert.ok(!result.retrieval_warning, result.retrieval_warning);
    assert.match(result.messages.at(-1), /\?$/);
    assert.doesNotMatch(result.messages.join('\n'), /Reyes|\p{Extended_Pictographic}|\b(?:sir|maam|boss)\b/iu);
    assert.equal((result.messages.join(' ').match(/\?/g) || []).length, 1);
    if (index === 0) assert.ok(!result.messages.some(containsCommercialVideoForm), 'Business before form');
    if (index === 1) {
        assert.ok(!result.messages.some(containsCommercialVideoForm), 'Sample before form');
        assert.match(result.messages.at(-1), /seconds|duration/i);
    }
    if (index === 2) {
        const process = result.messages.find(message => message.includes('STEP-BY-STEP PROCESS PO:'));
        assert.ok(process, 'Full process after duration');
        for (let step = 1; step <= 7; step++) assert.ok(process.includes('\n' + step + '. '));
        assert.match(process, /PHP150[\s\S]*FREE poster ads[\s\S]*PHP100/);
    }
    if (index === 3) assert.equal(result.messages.filter(containsCommercialVideoForm).length, 1);
    if (index < 4) assert.equal(result.collected_details['Goal ng video'], undefined, 'Never infer a business objective from the service request');
    if (index === 4) { assert.equal(result.details_complete, true); assert.equal(result.has_clear_request, true); assert.equal(result.intake_action, 'handoff'); }
    details = result.collected_details;
    request = { hasClearRequest: result.has_clear_request, requestType: result.request_type, requestEvidence: result.request_evidence };
    turns.push({ customer: text, messages: result.messages, media: result.media_document_ids || result.drive_file_document_ids || [], knowledge: result.knowledge.map(row => ({ title: row.title, document_id: row.document_id })) });
    for (const [part, message] of result.messages.entries()) history.push({ id: 'preview-page-' + index + '-' + part, from: { id: page.fb_page_id, name: page.name }, message, created_time: new Date(Date.now() + part).toISOString() });
    console.log(JSON.stringify({ turn: index + 1, passed: true, messages: result.messages.length, sampleSelected: Boolean(result.media_document_ids?.length || result.drive_file_document_ids?.length) }));
}
const after = checked(await db.from('chatbot_configs').select('page_id,enabled').in('page_id', before.map(row => row.page_id)));
assert.deepEqual(after.sort((a,b) => a.page_id.localeCompare(b.page_id)), before.sort((a,b) => a.page_id.localeCompare(b.page_id)));
const report = { at: new Date().toISOString(), page: page.name, enabled: config.enabled, sourceKnowledgePageId: config.knowledge_source_page_id || config.page_id,
    turns, details, passed: true, databaseWrites: 0, messengerMessagesSent: 0 };
await writeFile(new URL('../../data/sales-conversation-preview-2026-10-21.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, turns: turns.length, enabled: config.enabled, databaseWrites: 0, messengerMessagesSent: 0 }));
