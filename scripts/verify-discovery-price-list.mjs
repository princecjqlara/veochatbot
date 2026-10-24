// Authenticated production previews only: no customer sends or settings writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { containsCommercialVideoForm } from '../src/lib/chatbot-intake.ts';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const origin = 'https://veochatbot.vercel.app';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const checked = result => { if (result.error) throw new Error(result.error.message); return result.data; };
const before = checked(await db.from('chatbot_configs').select('*').order('page_id'));
const pages = checked(await db.from('pages').select('id,name'));
const page = pages.find(page => page.name === 'Vista Media Agency');
assert.ok(page);
const members = checked(await db.from('user_pages').select('user_id').eq('page_id', page.id).limit(1));
const token = await encode({ secret: process.env.NEXTAUTH_SECRET, token: { id: members[0].user_id, name: 'Discovery flow verification' }, maxAge: 600 });
const headers = { Cookie: '__Secure-next-auth.session-token=' + token, 'Content-Type': 'application/json' };
const endpoint = origin + '/api/pages/' + page.id + '/chatbot';
const turns = [];
const history = [];
let details = {};
let formCount = 0;
for (const [index, message] of [
    'Magkano po ang video?',
    'Bakery po. Preview Bakery ang business name.',
    'Presyo muna please, magkano?',
    '24 seconds po ang gusto kong video.',
    'Sige, gusto kong mag-proceed sa commercial video. Pakisend ng form.'
].entries()) {
    history.push({ role: 'user', content: message });
    const response = await fetch(endpoint, { method: 'POST', headers,
        body: JSON.stringify({ message, contact_name: 'Miguel Reyes', history, collected_details: details }), signal: AbortSignal.timeout(90000) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ error: body.error, message: body.message }));
    await writeFile(new URL('../../data/discovery-price-list-preview-latest.json', import.meta.url), JSON.stringify({ turn: index + 1, body }, null, 2));
    assert.ok(!body.generation_warning, body.generation_warning);
    assert.ok(!body.retrieval_warning, body.retrieval_warning);
    const copy = body.messages.join('\n');
    const forms = body.messages.filter(containsCommercialVideoForm);
    formCount += forms.length;
    if (index < 3) {
        assert.doesNotMatch(copy, /(?:PHP|\u20b1)\s*\d|\d\s*pesos/i, 'No money before business plus another detail');
        assert.doesNotMatch(copy, /buong (?:promo )?price list|STARTER PACK/i, 'No stripped-catalog announcement during discovery');
    }
    if (index === 0) { assert.equal(forms.length, 0); assert.match(body.messages.at(-1), /business|negosyo/i); }
    if (index === 1) { assert.equal(forms.length, 1); assert.match(body.messages.at(-1), /seconds|duration|haba/i); }
    if (index === 2) { assert.equal(forms.length, 0, 'Do not repeat the early form on every reply'); assert.match(body.messages.at(-1), /seconds|duration|haba/i); }
    if (index === 3) {
        const list = body.messages.find(message => message.includes('BUONG PRICE LIST'));
        assert.ok(list, 'Whole verified price list');
        for (const duration of [16, 24, 32, 40, 60, 120]) assert.ok(list.includes('1 ' + duration + '-second main commercial video'), 'Catalog includes ' + duration);
        assert.ok(list.length <= 2000, 'Full price list fits one Messenger text message');
        assert.ok(body.messages.some(message => message.includes('STEP-BY-STEP PROCESS PO:')));
    }
    if (index === 4) { assert.equal(forms.length, 1); assert.ok(forms[0].includes('Preferred Video Length: 24 seconds')); assert.equal(formCount, 2); }
    details = body.collected_details;
    turns.push({ customer: message, messages: body.messages, collectedDetails: details });
    history.push(...body.messages.map(content => ({ role: 'assistant', content })));
    console.log(JSON.stringify({ turn: index + 1, passed: true, forms: forms.length, messages: body.messages.length }));
}
const after = checked(await db.from('chatbot_configs').select('*').order('page_id'));
assert.deepEqual(after, before, 'Preview changes no Page settings');
const switches = after.map(config => ({ page: pages.find(page => page.id === config.page_id)?.name, enabled: config.enabled, followUpsEnabled: config.follow_up_enabled }));
assert.equal(switches.find(page => page.page === 'Vista Media Agency').enabled, false);
assert.equal(switches.find(page => page.page === 'SAMA KANA MEDIA').enabled, false);
const report = { at: new Date().toISOString(), passed: true, page: page.name, turns, formCount, switches, settingsPreserved: true, customerMessagesSent: 0 };
await writeFile(new URL('../../data/discovery-price-list-production-2026-10-25.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, turns: turns.length, formCount, settingsPreserved: true, customerMessagesSent: 0 }));
