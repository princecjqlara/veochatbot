import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    userHasPageAccess: vi.fn(),
    getSupabaseAdmin: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.getSessionFromRequest }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: mocks.userHasPageAccess }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));

import { POST } from './route';

function contactBuilder() {
    const builder: Record<string, any> = {};
    builder.select = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.maybeSingle = vi.fn().mockResolvedValue({
        data: { id: 'contact_1', name: 'CJ Lara', psid: 'psid_1' },
        error: null
    });
    return builder;
}

function configBuilder() {
    const builder: Record<string, any> = {};
    builder.upsert = vi.fn(() => builder);
    builder.select = vi.fn(() => builder);
    builder.single = vi.fn().mockResolvedValue({
        data: {
            page_id: 'page_1',
            enabled: true,
            trial_mode_enabled: true,
            trial_contact_id: 'contact_1'
        },
        error: null
    });
    return builder;
}

describe('live Messenger chatbot trial controls', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user_1' } });
        mocks.userHasPageAccess.mockResolvedValue(true);
    });

    it('enables the bot while restricting it to one verified Page contact', async () => {
        const contacts = contactBuilder();
        const configs = configBuilder();
        mocks.getSupabaseAdmin.mockReturnValue({
            from: vi.fn((table: string) => table === 'contacts' ? contacts : configs)
        });

        const response = await POST(new Request('http://localhost/api/pages/page_1/chatbot/trial', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'configure', enabled: true, contact_id: 'contact_1' })
        }) as NextRequest, { params: Promise.resolve({ pageId: 'page_1' }) });

        expect(response.status).toBe(200);
        expect(configs.upsert).toHaveBeenCalledWith(expect.objectContaining({
            page_id: 'page_1',
            enabled: true,
            trial_mode_enabled: true,
            trial_contact_id: 'contact_1'
        }), { onConflict: 'page_id' });
        expect(await response.json()).toEqual(expect.objectContaining({
            success: true,
            config: expect.objectContaining({ trial_contact_id: 'contact_1' })
        }));
    });

    it('rejects users without Page access before reading contacts', async () => {
        mocks.userHasPageAccess.mockResolvedValue(false);

        const response = await POST(new Request('http://localhost/api/pages/page_1/chatbot/trial', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'configure', enabled: true, contact_id: 'contact_1' })
        }) as NextRequest, { params: Promise.resolve({ pageId: 'page_1' }) });

        expect(response.status).toBe(403);
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });

    it('explicitly resets intake without leaving a human handoff source', async () => {
        const payloads: Record<string, any> = {};
        const db = { from: (table: string) => {
            const chain: any = { select: () => chain, eq: () => chain, in: () => chain,
                maybeSingle: async () => ({ data: { id: 'contact_1', psid: 'psid_1' }, error: null }),
                delete: () => { payloads[table] = 'deleted'; return chain; },
                update: (payload: any) => { payloads[table] = payload; return chain; },
                then: (resolve: any) => Promise.resolve({ error: null }).then(resolve)
            };
            return chain;
        } };
        mocks.getSupabaseAdmin.mockReturnValue(db);
        const response = await POST(new Request('http://localhost/api/pages/page_1/chatbot/trial', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'reset', contact_id: 'contact_1' })
        }) as NextRequest, { params: Promise.resolve({ pageId: 'page_1' }) });
        expect(response.status).toBe(200);
        expect(payloads.contacts).toEqual(expect.objectContaining({ pipeline_stage: 'engaged', pipeline_stage_source: 'system' }));
        expect(payloads.chatbot_contact_states).toBe('deleted');
        expect(payloads.chatbot_follow_up_jobs.status).toBe('cancelled');
    });
});
