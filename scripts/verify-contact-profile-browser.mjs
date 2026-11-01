import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://localhost:3100';
assert(new URL(base).hostname === 'localhost' || new URL(base).hostname === '127.0.0.1', 'Use a local build with synthetic API fixtures');
const output = path.resolve(import.meta.dirname, '../.vercel');
const profile = path.join(output, 'profile-browser-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const inquiry = '2026-10-01T00:00:00Z', paidAt = '2026-10-03T04:00:00Z';
const proof = [{ message_id: 'customer-1', quote: 'For Facebook ads, landscape please.' }];
const fixture = {
    contact: { id: 'contact', name: 'Sample Customer', psid: 'test', pipeline_stage: 'converted', messenger_stage_label: 'Converted',
        chatbot_enabled: false, last_interaction_at: paidAt, tags: [{ id: 'old', name: 'Existing customer tag', color: '#2563eb' }, { id: 'history', name: 'History: Qualified', color: '#16a34a' }] },
    page: { id: 'page', name: 'Sample Page', messaging_auto_tag_checked_at: paidAt },
    detail_progress: { complete: false, collected_count: 1, required_count: 2, collected_details: { Purpose: 'Facebook ads' }, missing_details: ['Business name'] },
    saved_detail_keys: ['Purpose'], answer_conflicts: [{ field: 'Purpose', value: 'landscape', evidence: proof }],
    snapshot: { generation: 1, message_count: 2, source_cutoff_at: paidAt, payload: {
        summary_points: [{ text: 'The customer requested a landscape video for Facebook ads.', evidence: proof }],
        facts: [{ category: 'preference', key: 'Format', value: 'Landscape', evidence: proof }],
        answer_history: [{ field: 'Purpose', value: 'Facebook ads', evidence: proof }],
        extracted_answers: [{ field: 'Purpose', value: 'Facebook ads', evidence: proof }],
        conversation: { unique_question_count: 1, questions: [{ text: 'How much?', count: 2, first_at: inquiry, message_ids: ['customer-1'] }],
            payment_evidence: [{ acknowledgment: true, kind: 'page_payment_ack', at: paidAt, message_id: 'page-1', quote: 'Payment received, thank you.', amount: 700 }],
            invoice_requests: [{ reference: '123', at: inquiry, message_id: 'page-1' }] }
    } },
    job: { status: 'ready' }, source_stale: false, first_inquiry_at: inquiry, first_recorded_conversion_at: paidAt, inquiry_to_conversion_hours: 52,
    finance: { purchases: [{ id: 'order', description: 'Commercial video', total_minor: 70000, currency: 'PHP' }],
        payments: [{ id: 'dp', amount_minor: 15000, currency: 'PHP', kind: 'deposit', reference: 'SAMPLE-REF', occurred_at: inquiry, verified_at: paidAt, verified_by_name: 'Sample staff' }],
        metrics: { currencies: [{ currency: 'PHP', received_minor: 70000, refunded_minor: 0, net_minor: 70000 }], recorded_order_count: 1, purchase_count: 1,
            orders: [{ id: 'order', description: 'Commercial video', purchased_at: inquiry, reference: 'SAMPLE-ORDER', total_minor: 70000, currency: 'PHP', paid_minor: 70000,
                outstanding_minor: 0, overpaid_minor: 0, payment_status: 'fully_paid', inquiry_to_deposit_hours: 4, deposit_to_full_hours: 48, first_full_payment_at: paidAt }],
            inquiry_to_first_payment_hours: 4, inquiry_to_first_deposit_hours: 4, first_payment_at: inquiry }
    },
    follow_up_metrics: { tracked_total: 1, before_first_payment: 1, before_deposit: 1, coverage: 'Only attributed follow-ups are counted' },
    ad: { attribution_status: 'unknown' }, ad_touches: [], timeline: [
        { id: 'inquiry', at: inquiry, type: 'inquiry', title: 'First known customer inquiry', basis: 'Conversation source' },
        { id: 'stage', at: paidAt, type: 'stage', title: 'Meta stage: Converted', basis: 'Applied stage event' },
        { id: 'payment', at: paidAt, type: 'payment', title: 'Verified full payment', basis: 'Staff verified', amount_minor: 70000, currency: 'PHP' }
    ], controls: { conversion_projection: { status: 'documented_confirmation', payment_at: paidAt } },
    projection_comparison: { prior: { issued_at: inquiry, source_cutoff_at: inquiry, prediction: { close_windows: { '720': { median_date_pht: '2026-10-03' } } } },
        acknowledgment_at: paidAt, comparison_basis: 'Forecast target: payment acknowledgment in chat.' }
};
const tagRows = {
    manual: [{ id: 'manual', name: 'Existing customer tag', color: '#2563eb', owner_type: 'page', owner_id: 'page' }],
    history: [{ id: 'history', name: 'History: Qualified', color: '#16a34a', system_key: 'stage_history:qualified', owner_type: 'page', owner_id: 'page' }],
    system: []
};
const sourceAd = { ad_id: '100', ad_name: 'Original campaign ad', ad_title: 'Original creative', video_url: 'https://example.com/original.mp4',
    post_id: '10_20', creative_basis: 'referral_snapshot', campaign_name: 'October campaign', campaign_id: '300', adset_name: 'Local audience', adset_id: '400', creative_id: '500', metadata_status: 'available' };
const sourceOrigin = { event_key: 'origin', at: inquiry, received_at: inquiry, event_kind: 'message', message_id: 'customer-1', role: 'origin', source: 'ADS', referral_type: 'OPEN_THREAD', referral_code: 'sample-code', ad: sourceAd };
let sourceData = { attribution_status: 'verified_inline', first_inquiry_at: inquiry, inquiry_basis: 'live_message', origin: { ad: sourceAd, evidence: sourceOrigin },
    touches: [{ ...sourceOrigin, event_key: 'later', role: 'later_touch', at: paidAt, ad: { ...sourceAd, ad_id: '200', ad_name: 'Later campaign ad' } }, sourceOrigin], total: 26, page: 1, page_size: 25,
    coverage: 'A later click does not establish the originating ad.' };
fixture.timeline.push({ id: 'ad-later', at: paidAt, type: 'ad', title: 'Ad touch: 200', basis: 'message', source_event_key: 'later' });
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--incognito', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
], { windowsHide: true, stdio: 'ignore' });
let ws, cdp;
const errors = [], checks = [], unexpected = [];
try {
    let port;
    for (let i = 0; i < 100; i++) {
        const file = path.join(profile, 'DevToolsActivePort');
        if (fs.existsSync(file)) { port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]); try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch {} }
        await sleep(100);
    }
    assert(port, 'Isolated Chrome did not start');
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let seq = 0;
    const pending = new Map();
    cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    ws.addEventListener('message', async event => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) { const wait = pending.get(message.id); pending.delete(message.id); message.error ? wait.reject(Error(message.error.message)) : wait.resolve(message.result); }
        if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails?.text);
        if (message.method === 'Fetch.requestPaused') {
            const { requestId, request } = message.params, url = new URL(request.url);
            let body;
            if (url.pathname === '/api/auth/session') body = { user: { id: 'user', name: 'Sample Staff' }, expires: '2099-01-01T00:00:00Z' };
            else if (url.pathname === '/api/pages') body = { pages: [{ id: 'page', name: 'Sample Page' }] };
            else if (url.pathname.endsWith('/profile/messages')) body = { items: [{ message_id: 'customer-1', sent_at: inquiry, sender: 'customer', text: 'For Facebook ads, landscape please.', attachment_count: 0 }], total: 1, generation: 1 };
            else if (url.pathname.endsWith('/profile/sources')) {
                const focused = url.searchParams.get('eventKey'), page = Number(url.searchParams.get('page') || 1);
                body = { ...sourceData, page, touches: focused ? sourceData.touches.filter(touch => touch.event_key === focused) : page === 1 ? sourceData.touches : [sourceOrigin], total: focused ? 1 : sourceData.total };
            }
            else if (url.pathname === '/api/ad-quality/resolve') body = { results: [{ adId: '100', resolved: true }, { adId: '200', resolved: true }] };
            else if (url.pathname.endsWith('/profile')) body = fixture;
            else if (url.pathname.endsWith('/projection')) body = { conversion_projection: fixture.controls.conversion_projection, bot_control: { enabled: false, reason: 'contact_disabled' } };
            else if (url.pathname === '/api/tags') body = { items: tagRows[url.searchParams.get('kind') || 'manual'] || [], total: 1, page: 1, pageSize: 50, kind_counts: { manual: 1, history: 1, system: 0 } };
            else if (url.pathname.startsWith('/api/pages/') && url.pathname.endsWith('/team')) body = { members: [] };
            else { unexpected.push(url.pathname); body = {}; }
            await cdp('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }).catch(error => errors.push(error.message));
        }
    });
    const evaluate = async expression => {
        const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description || 'Browser evaluation failed');
        return response.result.value;
    };
    const waitFor = async expression => { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await sleep(200); } throw Error('UI condition did not become ready: ' + expression); };
    const clickText = async text => { assert(await evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(text)});button?.click();return !!button;})()`), 'Missing button: ' + text); await sleep(150); };
    const noOverflow = async label => { const size = await evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth})'); assert(size.document <= size.viewport + 1, label + ' overflow'); };
    await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/*', requestStage: 'Request' }] });
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: base + '/dashboard/contacts/contact?pageId=page' });
    await waitFor("document.body?.innerText.includes('The customer requested a landscape video')");
    await noOverflow('Desktop profile'); checks.push('Desktop profile, required answers and source-grounded summary');
    assert(await evaluate("document.body.innerText.includes('Answers to review (1)')"));
    await evaluate("[...document.querySelectorAll('summary')].find(item=>item.textContent.includes('Answers to review')).click()");
    assert(await evaluate("document.body.innerText.includes('The saved answer is retained above.')")); checks.push('Conflicting answers retain the saved form and show review evidence');
    let shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'profile-desktop.png'), Buffer.from(shot.data, 'base64'));
    await clickText('View source');
    await waitFor("document.body.innerText.includes('For Facebook ads, landscape please.')"); checks.push('Summary source opens the cited conversation message');
    await clickText('Sources'); await waitFor("document.body.innerText.includes('Original campaign ad')");
    await evaluate("[...document.querySelectorAll('summary')].find(item=>item.textContent==='Ad, campaign and ad-set details').click()");
    assert(await evaluate("document.body.innerText.includes('October campaign')&&document.body.innerText.includes('Local audience')"));
    await evaluate("document.querySelector('button[aria-label=\"Preview ad 100\"]').click()");
    assert(await evaluate("!!document.querySelector('[role=dialog] video[controls]')"));
    await evaluate("document.querySelector('button[aria-label=\"Close ad preview\"]').click()");
    await clickText('Refresh ad previews'); await waitFor("document.body.innerText.includes('Original referral snapshots and attribution stay unchanged.')");
    await clickText('Next sources'); await waitFor("document.body.innerText.includes('Page 2 of 2')");
    checks.push('Origin creative video, campaign/ad-set details, preview refresh and paginated source history');
    shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'sources-desktop.png'), Buffer.from(shot.data, 'base64'));
    await clickText('Timeline'); await clickText('Ads'); await clickText('View ad and referral evidence');
    await waitFor("document.body.innerText.toLowerCase().includes('selected source event')");
    assert(await evaluate("document.body.innerText.includes('Later campaign ad')&&document.body.innerText.includes('Later touch')"));
    await clickText('Show all source events'); await waitFor("document.body.innerText.toLowerCase().includes('recorded ad and referral touches')");
    sourceData = { ...sourceData, attribution_status: 'unknown', origin: null, touches: sourceData.touches.map(touch => touch.role === 'origin' ? { ...touch, role: 'unconfirmed_touch' } : touch) };
    await clickText('Overview'); await clickText('Sources'); await waitFor("document.body.innerText.includes('The originating ad is not verified.')");
    assert(await evaluate("document.body.innerText.includes('Later campaign ad')"));
    checks.push('Timeline opens the exact referral and later ads never become an unknown origin');
    await clickText('Payments'); await waitFor("document.body.innerText.includes('Down payment')");
    assert(await evaluate("document.body.innerText.includes('₱700.00')"));
    await clickText('Record verified payment'); assert(await evaluate("!!document.querySelector('input[type=checkbox][required]')"));
    assert(await evaluate("document.body.innerText.includes('Transaction reference')")); checks.push('Verified ledger, balances and explicit verification form');
    await clickText('Cancel'); await clickText('Timeline'); await clickText('Lead stages');
    assert(await evaluate("document.body.innerText.includes('Meta stage: Converted')&&!document.body.innerText.includes('First known customer inquiry')")); checks.push('Journey timeline stage filter');
    await clickText('Projection'); assert(await evaluate("document.body.innerText.includes('Same day')")); checks.push('Pre-outcome forecast comparison and actual journey');
    await clickText('Overview');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: true });
    await sleep(200); await noOverflow('Mobile profile'); await evaluate("document.querySelector('h1').scrollIntoView()");
    shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'profile-mobile.png'), Buffer.from(shot.data, 'base64'));
    checks.push('Mobile profile without horizontal page overflow');
    await clickText('Sources'); await waitFor("document.body.innerText.includes('The originating ad is not verified.')"); await noOverflow('Mobile source history'); checks.push('Mobile source view without page overflow');
    await evaluate("document.querySelector('h2').scrollIntoView()"); shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, 'sources-mobile.png'), Buffer.from(shot.data, 'base64'));
    await cdp('Page.navigate', { url: base + '/dashboard/tags' });
    await waitFor("document.querySelector('tbody')?.innerText.includes('Existing customer tag')");
    await clickText('Stage history (1)'); await waitFor("document.querySelector('tbody')?.innerText.includes('History: Qualified')");
    assert(await evaluate("!document.querySelector('tbody').innerText.includes('Existing customer tag')"));
    await noOverflow('Mobile tags'); checks.push('Manual and automatic history tags remain in separate views');
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    const receipt = { passed: true, checks, javascript_errors: errors, synthetic_financial_records_only: true };
    fs.writeFileSync(path.join(output, 'profile-browser.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
    const receipt = { passed: false, checks, error: error.message, javascript_errors: errors, unexpected_requests: unexpected };
    fs.writeFileSync(path.join(output, 'profile-browser.json'), JSON.stringify(receipt, null, 2)); console.error(JSON.stringify(receipt, null, 2)); process.exitCode = 1;
} finally {
    if (cdp && ws?.readyState === 1) await cdp('Browser.close').catch(() => {}); ws?.close();
    if (chrome.exitCode === null) await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(2000)]);
    if (chrome.exitCode === null) chrome.kill(); await sleep(300);
    assert(path.resolve(profile).startsWith(output + path.sep) && path.basename(profile).startsWith('profile-browser-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
