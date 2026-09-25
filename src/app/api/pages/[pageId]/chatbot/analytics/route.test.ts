import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    userHasPageAccess: vi.fn(),
    rpc: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.getSessionFromRequest }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: mocks.userHasPageAccess }));

import { GET } from './route';

describe('chatbot analytics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'collaborator_1' } });
        mocks.userHasPageAccess.mockResolvedValue(true);
        mocks.rpc.mockImplementation((name: string) => Promise.resolve({
            data: name === 'get_chatbot_contact_metrics'
                ? { total: 12 }
                : name === 'get_contact_pipeline_counts'
                    ? { new: 12 }
                    : { generated_at: '2026-09-22T00:00:00.000Z', conversations: { conversations: 3 } },
            error: null
        }));
        mocks.getSupabaseAdmin.mockReturnValue({ rpc: mocks.rpc });
    });

    it('returns Page-scoped analytics to any Page member', async () => {
        const response = await GET(
            new Request('http://localhost/api/pages/page_1/chatbot/analytics?days=30') as NextRequest,
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.days).toBe(30);
        expect(body.analytics.contacts.total).toBe(12);
        expect(mocks.userHasPageAccess).toHaveBeenCalledWith('collaborator_1', 'page_1');
        expect(mocks.rpc).toHaveBeenCalledWith('get_chatbot_contact_metrics', expect.objectContaining({
            p_page_id: 'page_1',
            p_from: expect.any(String),
            p_to: expect.any(String)
        }));
        expect(mocks.rpc).toHaveBeenCalledWith('get_contact_pipeline_counts', { p_page_id: 'page_1' });
        expect(mocks.rpc).toHaveBeenCalledWith('get_chatbot_activity_analytics', expect.any(Object));
    });

    it('falls back to seven days for unsupported ranges', async () => {
        const response = await GET(
            new Request('http://localhost/api/pages/page_1/chatbot/analytics?days=365') as NextRequest,
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect((await response.json()).days).toBe(7);
    });

    it('rejects users without Page membership before querying analytics', async () => {
        mocks.userHasPageAccess.mockResolvedValue(false);
        const response = await GET(
            new Request('http://localhost/api/pages/page_1/chatbot/analytics') as NextRequest,
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(403);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
});
