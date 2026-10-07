import { createHmac } from 'node:crypto';
const origin = 'https://veochatbot.vercel.app';
const verificationUrl = new URL('/api/facebook/webhook', origin);
verificationUrl.searchParams.set('hub.mode', 'subscribe');
verificationUrl.searchParams.set('hub.verify_token', process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN);
verificationUrl.searchParams.set('hub.challenge', 'chatbot-release-check');
const handshake = await fetch(verificationUrl, { signal: AbortSignal.timeout(15000) });
if (handshake.status !== 200 || await handshake.text() !== 'chatbot-release-check') throw new Error('Webhook verification failed');
console.log('Production webhook verification passed');
const payload = JSON.stringify({ object: 'page', entry: [] });
const signature = 'sha256=' + createHmac('sha256', process.env.FACEBOOK_APP_SECRET).update(payload).digest('hex');
const processing = await fetch(new URL('/api/facebook/webhook', origin), {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
  body: payload, signal: AbortSignal.timeout(15000)
});
if (processing.status !== 200 || !(await processing.json()).success) throw new Error('Empty webhook processing failed');
console.log('Production signed empty webhook passed; no customer events or messages');
const dashboard = await fetch(new URL('/dashboard', origin), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
if (![200, 302, 303, 307, 308].includes(dashboard.status)) throw new Error(`Dashboard unavailable: ${dashboard.status}`);
console.log('Production dashboard route passed', dashboard.status);
