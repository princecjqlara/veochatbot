// Authenticated production preview only. No customer sends, settings or contact writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { containsCommercialVideoForm } from '../src/lib/chatbot-intake.ts';
import { renderCommercialVideoProcess } from '../src/lib/chatbot-message-renderer.ts';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const originIndex = process.argv.indexOf('--origin');
const origin = originIndex >= 0 ? process.argv[originIndex + 1] : 'https://veochatbot.vercel.app';
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const checked = result => { if (result.error) throw new Error(result.error.message); return result.data; };
const page = checked(await db.from('pages').select('id,name').eq('name', 'Commercial sa Negosyo Media').single());
const members = checked(await db.from('user_pages').select('user_id').eq('page_id', page.id).limit(1));
assert.ok(members[0]?.user_id, 'An authorized Page member is required');
const token = await encode({ secret: process.env.NEXTAUTH_SECRET, token: { id: members[0].user_id, name: 'Release verification' }, maxAge: 600 });
const headers = { Cookie: '__Secure-next-auth.session-token=' + token, 'Content-Type': 'application/json' };
const endpoint = origin + '/api/pages/' + page.id + '/chatbot';
const execute = promisify(execFile);
async function previewRequest(url, options = {}) {
    if (!process.argv.includes('--vercel-curl')) return fetch(url, options);
    const cli = join(process.env.APPDATA, 'npm/node_modules/vercel/dist/vc.js');
    const args = [cli, 'curl', new URL(url).pathname, '--deployment', origin, '--', '--silent', '--show-error',
        '--header', 'Cookie: ' + headers.Cookie, '--header', 'Content-Type: application/json', '--write-out', '\n%{http_code}'];
    if (options.method) args.push('--request', options.method);
    if (options.body) args.push('--data-binary', options.body);
    let output;
    try { output = await execute(process.execPath, args, { timeout: 90000, maxBuffer: 5_000_000 }); }
    catch (error) { throw new Error('Authenticated preview transport failed, exit code ' + error.code); }
    const match = output.stdout.trimEnd().match(/\n(\d{3})$/);
    assert.ok(match, 'Preview transport returned an HTTP status');
    const body = output.stdout.trimEnd().slice(0, -match[0].length);
    return { status: Number(match[1]), json: async () => JSON.parse(body) };
}
const response = await previewRequest(endpoint, { headers, signal: AbortSignal.timeout(20000) });
assert.equal(response.status, 200, 'Authenticated settings read');
const { config } = await response.json();
assert.equal(config.enabled, false, 'Bots stay off');
let details = {}; const history = []; const turns = [];
for (const [index, message] of [
    'Hi po',
    'Bakery po ang business namin. Preview Bakery ang business name.',
    '24 seconds po',
    'Sige, gusto kong mag-proceed sa commercial video. Pakisend ng form.',
    'Manila po ang location namin. Goal ng video ay i-promote ang fresh bread. Contact number 09171234567.'
].entries()) {
    history.push({ role: 'user', content: message });
    const reply = await previewRequest(endpoint, { method: 'POST', headers, body: JSON.stringify({ message, contact_name: 'Miguel Reyes', history, collected_details: details }), signal: AbortSignal.timeout(60000) });
    const result = await reply.json();
    assert.equal(reply.status, 200, result.message || result.error);
    await writeFile(new URL('../../data/sales-conversation-preview-diagnostic.json', import.meta.url), JSON.stringify({
        at: new Date().toISOString(), origin, turn: index + 1, messages: result.messages, sources: result.sources,
        media: result.media_items?.map(item => ({ id: item.id, title: item.title })), collected: result.collected_details
    }, null, 2));
    assert.ok(!result.generation_warning, result.generation_warning); assert.ok(!result.retrieval_warning, result.retrieval_warning);
    assert.match(result.messages.at(-1), /\?$/);
    assert.doesNotMatch(result.messages.join('\n'), /Reyes|\p{Extended_Pictographic}|\b(?:sir|maam|boss)\b/iu);
    assert.equal((result.messages.join(' ').match(/\?/g) || []).length, 1);
    if (index === 0) { assert.ok(!result.messages.some(containsCommercialVideoForm)); assert.match(result.messages.at(-1), /business|negosyo/i); }
    if (index === 1) { assert.ok(result.media_items?.length > 0, 'Existing sample is selected'); assert.ok(!result.messages.some(containsCommercialVideoForm)); assert.match(result.messages.at(-1), /seconds|duration/i); }
    if (index === 2) {
        const process = result.messages.find(text => text.includes('STEP-BY-STEP PROCESS PO:'));
        assert.ok(process); for (let step=1;step<=7;step++) assert.ok(process.includes('\n'+step+'. '));
        assert.match(process,/PHP150[\s\S]*FREE poster ads[\s\S]*PHP100/);
        assert.match(result.messages[0], /24-second main commercial video/);
        assert.match(result.messages[0], /2 add-on videos na tig-8 seconds/);
        assert.match(result.messages[0], /reference rate/);
    }
    if (index === 3) assert.equal(result.messages.filter(containsCommercialVideoForm).length, 1);
    if (index < 4) assert.equal(result.collected_details['Goal ng video'], undefined);
    if (index === 4) { assert.equal(result.details_complete,true); assert.equal(result.intake_action,'handoff'); }
    details = result.collected_details;
    turns.push({ customer:message, messages:result.messages, sources:result.sources, samples:result.media_items?.map(row=>({id:row.id,title:row.title})) || [] });
    history.push(...result.messages.map(content=>({role:'assistant',content})));
    console.log(JSON.stringify({ turn:index+1, passed:true, sampleSelected:Boolean(result.media_items?.length) }));
}
const edgeCases = [];
if (process.argv.includes('--edge-cases')) {
    const processCopy = renderCommercialVideoProcess('Miguel Reyes', 'Preview Bakery');
    const common = [
        { role: 'user', content: 'Bakery po ang business namin. Preview Bakery ang business name.' },
        { role: 'assistant', content: 'Ito ang existing sample namin na related sa Preview Bakery.' }
    ];
    for (const scenario of [
        { name: 'process-before-price', message: '24 segundos po', duration: 24,
            history: [...common, { role: 'user', content: 'Paano po ang process?' }, { role: 'assistant', content: processCopy }] },
        { name: 'return-to-previous-duration', message: '16 seconds', duration: 16,
            history: [...common,
                { role: 'user', content: '16 seconds' }, { role: 'assistant', content: 'PRICING PARA SA Preview Bakery\n16-second main commercial video: PHP699.' },
                { role: 'user', content: '24 seconds' }, { role: 'assistant', content: 'PRICING PARA SA Preview Bakery\n24-second main commercial video: PHP899. May 2 add-on videos na tig-8 seconds.' },
                { role: 'assistant', content: processCopy }] }
    ]) {
        const reply = await previewRequest(endpoint, { method: 'POST', headers,
            body: JSON.stringify({ message: scenario.message, contact_name: 'Miguel Reyes', history: scenario.history, collected_details: { 'Business Name': 'Preview Bakery' } }),
            signal: AbortSignal.timeout(60000) });
        const result = await reply.json();
        assert.equal(reply.status, 200, result.message || result.error);
        assert.ok(!result.retrieval_warning, result.retrieval_warning);
        assert.equal(result.messages.length, 2, 'One intact updated price and one buying question');
        assert.match(result.messages[0], new RegExp(scenario.duration + '-second main commercial video'));
        assert.match(result.messages[0], /reference rate/);
        assert.ok(!result.messages.some(containsCommercialVideoForm));
        assert.doesNotMatch(result.messages.join('\n'), /STEP-BY-STEP PROCESS PO:/);
        assert.match(result.messages.at(-1), /\?$/);
        edgeCases.push({ name: scenario.name, messages: result.messages, passed: true });
        console.log(JSON.stringify({ scenario: scenario.name, passed: true }));
    }
}
const { enabled } = checked(await db.from('chatbot_configs').select('enabled').eq('page_id',page.id).single());
assert.equal(enabled,false);
await writeFile(new URL('../../data/sales-conversation-production-check-2026-10-21.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),origin,page:page.name,turns,edgeCases,passed:true,enabled,databaseWrites:0,messengerMessagesSent:0},null,2));
console.log(JSON.stringify({passed:true,turns:turns.length,edgeCases:edgeCases.length,enabled,databaseWrites:0,messengerMessagesSent:0}));
