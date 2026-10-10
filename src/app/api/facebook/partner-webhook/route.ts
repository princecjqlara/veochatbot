import { createHmac } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/facebook';
import { GET as verifyWebhook, POST as processWebhook } from '../webhook/route';

export const maxDuration = 300;

// Keep the existing app callback working for every other Page while routing
// explicitly selected Pages through the AI chatbot's existing delivery path.
export async function GET(request: NextRequest) {
    return verifyWebhook(request);
}

export async function POST(request: NextRequest) {
    const partnerSecret = process.env.FACEBOOK_PARTNER_APP_SECRET;
    const primarySecret = process.env.FACEBOOK_APP_SECRET;
    const legacyCallback = process.env.FACEBOOK_PARTNER_LEGACY_WEBHOOK_URL;
    const pageIds = new Set((process.env.FACEBOOK_PARTNER_CHATBOT_PAGE_IDS || '')
        .split(',').map(value => value.trim()).filter(Boolean));
    if (!partnerSecret || !primarySecret || !legacyCallback || pageIds.size === 0) {
        return NextResponse.json({ error: 'Partner webhook routing is not configured' }, { status: 503 });
    }
    let callbackUrl: URL;
    try {
        callbackUrl = new URL(legacyCallback);
        if (callbackUrl.protocol !== 'https:' || callbackUrl.pathname.includes('partner-webhook')) throw new Error('Invalid callback');
    } catch {
        return NextResponse.json({ error: 'Invalid partner callback configuration' }, { status: 503 });
    }
    const body = await request.text();
    if (!verifyWebhookSignature(body, request.headers.get('x-hub-signature-256') || '', partnerSecret)) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
    let payload: { object?: string; entry?: Array<{ id?: string }> };
    try {
        payload = JSON.parse(body);
        if (!payload || payload.object !== 'page' || !Array.isArray(payload.entry)
            || payload.entry.some(entry => !entry || typeof entry.id !== 'string')) throw new Error('Invalid payload');
    } catch {
        return NextResponse.json({ error: 'Invalid Page webhook payload' }, { status: 400 });
    }
    const chatbotEntries = payload.entry.filter(entry => pageIds.has(entry.id!));
    const legacyEntries = payload.entry.filter(entry => !pageIds.has(entry.id!));
    const operations: Array<Promise<{ destination: string; ok: boolean; status: number }>> = [];
    if (chatbotEntries.length) {
        const chatbotBody = JSON.stringify({ ...payload, entry: chatbotEntries });
        operations.push(processWebhook(new NextRequest(new URL('/api/facebook/webhook', request.url), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', primarySecret).update(chatbotBody).digest('hex')
            },
            body: chatbotBody
        })).then(response => ({ destination: 'chatbot', ok: response.ok, status: response.status })));
    }
    if (legacyEntries.length) {
        const legacyBody = JSON.stringify({ ...payload, entry: legacyEntries });
        operations.push(fetch(callbackUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', partnerSecret).update(legacyBody).digest('hex')
            },
            body: legacyBody,
            redirect: 'error',
            signal: AbortSignal.timeout(240_000)
        }).then(response => ({ destination: 'legacy', ok: response.ok, status: response.status })));
    }
    const results = await Promise.allSettled(operations);
    const failures = results.flatMap<{ destination: string; status?: number; message?: string }>(result => result.status === 'rejected'
        ? [{ destination: 'routing', message: result.reason instanceof Error ? result.reason.message : 'Routing failed' }]
        : result.value.ok ? [] : [result.value]);
    if (failures.length) {
        console.error('[FB_PARTNER_WEBHOOK]', failures);
        return NextResponse.json({ error: 'Webhook processing failed; retry required' }, { status: 503 });
    }
    console.log('[FB_PARTNER_WEBHOOK]', { chatbotEntries: chatbotEntries.length, legacyEntries: legacyEntries.length });
    return NextResponse.json({ success: true, chatbot_entries: chatbotEntries.length, legacy_entries: legacyEntries.length });
}
