// Isolated local UI fixture. All form requests are intercepted; no customer writes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const output = path.resolve('..', 'data', 'sales-assistant-browser-2026-10-30');
fs.mkdirSync(output, { recursive: true });
const profile = path.join(output, 'profile-' + Date.now()); fs.mkdirSync(profile);
const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0','--user-data-dir=' + profile,'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
try {
    let port;
    for (let i = 0; i < 100; i++) {
        const file = path.join(profile, 'DevToolsActivePort');
        if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); break; }
        await pause(100);
    }
    assert(port, 'Test browser did not start');
    const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    ws = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await new Promise((yes, no) => { ws.addEventListener('open', yes, { once: true }); ws.addEventListener('error', no, { once: true }); });
    let id = 0; const pending = new Map(); const errors = []; const submissions = [];
    const command = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params })); });
    const fields = [
        { label: 'Business Name', required: true, enabled: true }, { label: 'Business Industry', required: true, enabled: true },
        { label: 'Product or Service', required: true, enabled: true }, { label: 'Preferred Style', required: true, enabled: true },
        { label: 'Goal ng video', required: true, enabled: true }, { label: 'Additional Instructions', required: false, enabled: true }
    ];
    ws.addEventListener('message', async event => {
        const message = JSON.parse(event.data);
        if (message.id) { const promise = pending.get(message.id); if (promise) { pending.delete(message.id); message.error ? promise.reject(message.error) : promise.resolve(message.result); } }
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
        if (message.method === 'Fetch.requestPaused') {
            const request = message.params.request;
            if (request.url.includes('/api/sales-form')) {
                const form = request.method === 'POST' ? JSON.parse(request.postData) : null;
                if (form) submissions.push(form);
                const body = form ? { details: { ...form.details, ...(submissions.length === 1 ? { 'Business Name': 'Changed in chat' } : {}) }, conflicts: submissions.length === 1 ? ['Business Name'] : [],
                    message: submissions.length === 1 ? 'Some answers changed in chat. Review those fields.' : 'Saved po! Continue in chat.' } :
                    { fields, details: { 'Business Name': 'Tea House', 'Product or Service': 'Milk Tea' }, suggestions: { 'Industry Category': 'Food & Beverage' } };
                await command('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: form && submissions.length === 1 ? 409 : 200,
                    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
            } else await command('Fetch.continueRequest', { requestId: message.params.requestId });
        }
    });
    const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
    const until = async (expression, label) => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await pause(100); } throw new Error(label); };
    await command('Runtime.enable'); await command('Page.enable');
    await command('Fetch.enable', { patterns: [{ urlPattern: '*api/sales-form*' }] });
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await command('Page.navigate', { url: 'http://127.0.0.1:3017/sales-form?token=fixture' });
    await until("document.querySelectorAll('textarea').length === 6", 'Form did not render');
    assert.equal(await evaluate("document.querySelector('textarea').value"), 'Tea House');
    assert(await evaluate("document.body.innerText.includes('Suggested Industry Category: Food & Beverage')"));
    assert(await evaluate("[...document.querySelectorAll('textarea')].every(field => !field.required)"));
    assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile form overflows');
    fs.writeFileSync(path.join(output, 'mobile.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
    await evaluate("document.querySelector('button').click()");
    await until("document.body.innerText.includes('This answer changed')", 'Conflict review was not shown');
    assert.equal(await evaluate("document.querySelector('textarea').value"), 'Changed in chat');
    await evaluate("document.querySelector('button').click()");
    await until("document.body.innerText.includes('Saved po!')", 'Partial submission did not save');
    assert.equal(submissions[1].base['Business Name'], 'Changed in chat');
    await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    fs.writeFileSync(path.join(output, 'desktop.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ success: true, checks: ['six optional fields','saved chat answers prefilled','unconfirmed suggestion shown','mobile width','409 conflict review','partial save','latest values used as next submission base'], runtimeErrors: errors, liveCustomerWrites: 0 }, null, 2));
    console.log('PASS: mobile/desktop form, prefilling, optional fields, conflicts and partial save; no customer writes.');
} finally { ws?.close(); child.kill(); }
