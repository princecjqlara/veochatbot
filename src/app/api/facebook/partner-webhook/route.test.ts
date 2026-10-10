import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ processWebhook: vi.fn(), verifyWebhook: vi.fn() }));
vi.mock('../webhook/route', () => ({ POST: mocks.processWebhook, GET: mocks.verifyWebhook }));
import { GET, POST } from './route';

function request(payload: unknown, secret = 'partner-secret') {
    const body = JSON.stringify(payload);
    return new NextRequest('https://bot.example/api/facebook/partner-webhook', {
        method: 'POST', body,
        headers: { 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') }
    });
}

describe('Partner Page webhook routing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('FACEBOOK_PARTNER_APP_SECRET', 'partner-secret');
        vi.stubEnv('FACEBOOK_APP_SECRET', 'primary-secret');
        vi.stubEnv('FACEBOOK_PARTNER_LEGACY_WEBHOOK_URL', 'https://legacy.example/api/facebook/webhook');
        vi.stubEnv('FACEBOOK_PARTNER_CHATBOT_PAGE_IDS', 'bot-page, another-bot-page');
        mocks.processWebhook.mockResolvedValue(new Response(JSON.stringify({ success: true })));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))));
    });
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

    it('delegates the Meta verification handshake to the configured verifier', async () => {
        const input = new NextRequest('https://bot.example/api/facebook/partner-webhook?hub.challenge=test');
        mocks.verifyWebhook.mockResolvedValue(new Response('test'));
        expect(await (await GET(input)).text()).toBe('test');
        expect(mocks.verifyWebhook).toHaveBeenCalledWith(input);
    });
    it('rejects a signature from another app without processing or forwarding', async () => {
        expect((await POST(request({ object: 'page', entry: [{ id: 'bot-page' }] }, 'wrong-secret'))).status).toBe(401);
        expect(mocks.processWebhook).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('splits mixed batches and preserves every entry and event for the correct handler', async () => {
        const bot = { id: 'bot-page', messaging: [{ message: { mid: 'customer-1', text: 'price?' } }], standby: [{ message: { is_echo: true } }] };
        const legacy = { id: 'other-page', messaging: [{ message: { mid: 'customer-2', text: 'hi' } }], changes: [{ field: 'feed' }] };
        const response = await POST(request({ object: 'page', entry: [bot, legacy] }));
        expect(response.status).toBe(200);
        const localRequest = mocks.processWebhook.mock.calls[0][0] as NextRequest;
        const localBody = await localRequest.text();
        expect(JSON.parse(localBody)).toEqual({ object: 'page', entry: [bot] });
        expect(localRequest.headers.get('x-hub-signature-256')).toBe('sha256=' + createHmac('sha256', 'primary-secret').update(localBody).digest('hex'));
        const [url, options] = vi.mocked(fetch).mock.calls[0];
        expect(String(url)).toBe('https://legacy.example/api/facebook/webhook');
        expect(JSON.parse(options!.body as string)).toEqual({ object: 'page', entry: [legacy] });
        expect((options!.headers as Record<string, string>)['X-Hub-Signature-256']).toBe('sha256=' + createHmac('sha256', 'partner-secret').update(options!.body as string).digest('hex'));
    });
    it('processes bot Pages once and does not also forward them to the old bot', async () => {
        expect((await POST(request({ object: 'page', entry: [{ id: 'bot-page' }] }))).status).toBe(200);
        expect(mocks.processWebhook).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('preserves the legacy handler for unselected Pages', async () => {
        expect((await POST(request({ object: 'page', entry: [{ id: 'other-page' }] }))).status).toBe(200);
        expect(mocks.processWebhook).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it.each(['chatbot', 'legacy', 'network'])('asks Meta to retry on %s failure', async destination => {
        if (destination === 'chatbot') mocks.processWebhook.mockResolvedValue(new Response('{}', { status: 500 }));
        if (destination === 'legacy') vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 500 }));
        if (destination === 'network') vi.mocked(fetch).mockRejectedValue(new Error('Connection failed'));
        expect((await POST(request({ object: 'page', entry: [{ id: 'bot-page' }, { id: 'other-page' }] }))).status).toBe(503);
    });
    it('fails closed if configuration is missing', async () => {
        vi.stubEnv('FACEBOOK_PARTNER_APP_SECRET', '');
        expect((await POST(request({ object: 'page', entry: [] }))).status).toBe(503);
        expect(mocks.processWebhook).not.toHaveBeenCalled();
    });
    it('rejects malformed payloads and callback loops', async () => {
        expect((await POST(request({ object: 'page', entry: [null] }))).status).toBe(400);
        vi.stubEnv('FACEBOOK_PARTNER_LEGACY_WEBHOOK_URL', 'https://bot.example/api/facebook/partner-webhook');
        expect((await POST(request({ object: 'page', entry: [] }))).status).toBe(503);
    });
    it('accepts an empty signed health check without touching customer records', async () => {
        expect((await POST(request({ object: 'page', entry: [] }))).status).toBe(200);
        expect(mocks.processWebhook).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
});
