import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { encode } = createRequire(import.meta.url)('next-auth/jwt');
const receipt = JSON.parse(fs.readFileSync('.vercel/workspace-launch-receipt.json', 'utf8'));
const token = await encode({ secret: process.env.NEXTAUTH_SECRET, maxAge: 300, token: { id: receipt.owner } });
const headers = { Cookie: `__Secure-next-auth.session-token=${token}; next-auth.session-token=${token}` };
const month = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7), page = receipt.pages[0].id;
const origin = 'https://veochatbot.vercel.app';
const checks = [
    ['calendar', `/api/ad-calendar?month=${month}&pageId=${page}`],
    ['ads_performance', `/api/ad-quality/performance?range=7&pageId=${page}`],
    ['lead_quality', `/api/ad-quality?range=7&pageId=${page}`],
    ['connection_mode', '/api/ad-quality/connection']
];
const result = { verified_at: new Date().toISOString(), owner_reports: {}, passed: false };
const replies = await Promise.allSettled(checks.map(async ([name, path]) => {
    const start = Date.now(), response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(90000) });
    const body = await response.json();
    const metadata = { status: response.status, elapsed_ms: Date.now() - start };
    if (name === 'calendar' && response.ok) { assert.equal(body.range.month, month); assert(body.days.length >= 28); Object.assign(metadata, { dates: body.days.length, inquiries: body.summary.inquiries, saved_spend_available: body.summary.spend.amount != null }); }
    if (name === 'ads_performance' && response.ok) { assert(Array.isArray(body.pages)); Object.assign(metadata, { pages: body.pages.length, creatives: body.ads.length, daily_rows: body.daily.length }); }
    if (name === 'lead_quality' && response.ok) { assert(Array.isArray(body.pages)); Object.assign(metadata, { pages: body.pages.length }); }
    if (name === 'connection_mode' && response.ok) { assert.equal(body.status, 'saved_data'); assert.equal(body.readOnlyReports, true); Object.assign(metadata, { mode: body.status, read_only: body.readOnlyReports === true }); }
    if (!response.ok) metadata.error = body.error || 'Report unavailable';
    return [name, metadata];
}));
for (let i = 0; i < replies.length; i++) {
    const reply = replies[i];
    const [name, metadata] = reply.status === 'fulfilled' ? reply.value : [checks[i][0], { status: null, error: String(reply.reason?.message || 'Report request failed') }];
    result.owner_reports[name] = metadata;
}
result.passed = Object.values(result.owner_reports).every(value => value.status === 200);
fs.writeFileSync('.vercel/owner-analytics-verification.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
