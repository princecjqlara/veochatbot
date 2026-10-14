import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureChatbotPageWebhook, repairSavedMessengerOutcomeTags } from './chatbot-page-maintenance';

const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
beforeEach(() => {
    vi.stubEnv('FACEBOOK_CLIENT_ID', 'primary');
    vi.stubEnv('FACEBOOK_CLIENT_SECRET', 'primary-secret');
    vi.stubEnv('FACEBOOK_PARTNER_APP_SECRET', 'partner-secret');
    vi.stubEnv('FACEBOOK_PARTNER_CHATBOT_PAGE_IDS', 'partner-page');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Page echo subscription watchdog', () => {
    it.each([['page', 'primary'], ['partner-page', 'partner']])('repairs missing echoes on %s and preserves existing fields', async (page, app) => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response({ data: [{ id: app, subscribed_fields: ['messages', 'messaging_postbacks', 'message_reads'] }] }))
            .mockResolvedValueOnce(response({ data: { is_valid: true, app_id: app } }))
            .mockResolvedValueOnce(response({ success: true }))
            .mockResolvedValueOnce(response({ data: [{ id: app, subscribed_fields: ['messages', 'messaging_postbacks', 'message_reads', 'message_echoes'] }] }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(ensureChatbotPageWebhook({ facebookPageId: page, accessToken: 'page-token' })).resolves.toEqual({ verified: true, repaired: true });
        const post = fetchMock.mock.calls.find(([, init]) => init.method === 'POST');
        expect(post?.[1].body.get('subscribed_fields').split(',')).toContain('message_reads');
        expect(post?.[1].body.get('subscribed_fields').split(',')).toContain('message_echoes');
        expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${app}|${app === 'primary' ? 'primary-secret' : 'partner-secret'}`);
    });

    it('avoids writes when subscriptions are healthy', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ id: 'primary', subscribed_fields: ['messages', 'messaging_postbacks', 'message_echoes'] }] }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(ensureChatbotPageWebhook({ facebookPageId: 'page', accessToken: 'token' })).resolves.toEqual({ verified: true, repaired: false });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a token from another app without making a subscription write', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response({ data: [{ id: 'primary', subscribed_fields: ['messages'] }] }))
            .mockResolvedValueOnce(response({ data: { is_valid: true, app_id: 'different-app' } }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(ensureChatbotPageWebhook({ facebookPageId: 'page', accessToken: 'token' })).rejects.toThrow('does not belong');
        expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    });

    it('reports a repair that Facebook acknowledged but did not persist', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response({ data: [{ id: 'primary', subscribed_fields: ['messages'] }] }))
            .mockResolvedValueOnce(response({ data: { is_valid: true, app_id: 'primary' } }))
            .mockResolvedValueOnce(response({ success: true }))
            .mockResolvedValueOnce(response({ data: [{ id: 'primary', subscribed_fields: ['messages'] }] }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(ensureChatbotPageWebhook({ facebookPageId: 'page', accessToken: 'token' })).rejects.toThrow('did not persist');
    });

    it('does not choose among ambiguous partner apps', async () => {
        const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ id: 'partner-1' }, { id: 'partner-2' }] }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(ensureChatbotPageWebhook({ facebookPageId: 'partner-page', accessToken: 'token' })).rejects.toThrow('one existing');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('saved stage outcome recovery', () => {
    it('requests a bounded Page-specific retry independently of Messenger history', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: 3, error: null });
        await expect(repairSavedMessengerOutcomeTags({ rpc }, 'page')).resolves.toBe(3);
        expect(rpc).toHaveBeenCalledWith('repair_chatbot_page_outcome_tags', { p_page_id: 'page', p_limit: 250 });
    });
    it('reports recovery failures for later retries', async () => {
        await expect(repairSavedMessengerOutcomeTags({ rpc: vi.fn().mockResolvedValue({ error: { message: 'database unavailable' } }) }, 'page')).rejects.toThrow('database unavailable');
    });
});
