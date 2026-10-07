import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    userHasPageAccess: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.getSessionFromRequest }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: mocks.userHasPageAccess }));

import { GET } from './route';

function listQuery(data: unknown[]) {
    const query: any = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn().mockResolvedValue({ data, error: null }),
        in: vi.fn().mockResolvedValue({ data, error: null })
    };
    return query;
}

describe('chatbot interruption list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user_1' } });
        mocks.userHasPageAccess.mockResolvedValue(true);
        const interruptionQuery = listQuery([{
            id: 'event_1', contact_id: 'contact_1', actor_name: 'Maria Santos',
            source: 'veobot', interruption_type: 'manual_message', lead_stage: null,
            collected_detail_count: 2, required_detail_count: 4,
            interrupted_at: '2026-09-28T08:00:00.000Z'
        }]);
        const contactQuery = listQuery([{ id: 'contact_1', name: 'Customer One' }]);
        mocks.getSupabaseAdmin.mockReturnValue({
            from: vi.fn((table: string) => table === 'chatbot_interruption_events'
                ? interruptionQuery
                : contactQuery)
        });
    });

    it('returns sender, interrupted contact, and timestamp without message content', async () => {
        const response = await GET(
            new Request('http://localhost/api/pages/page_1/chatbot/interruptions') as NextRequest,
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.interruptions).toEqual([{
            id: 'event_1', sent_by: 'Maria Santos', contact_name: 'Customer One',
            interruption_type: 'manual_message', lead_stage: null,
            collected_detail_count: 2, required_detail_count: 4,
            interrupted_at: '2026-09-28T08:00:00.000Z'
        }]);
        expect(mocks.userHasPageAccess).toHaveBeenCalledWith('user_1', 'page_1');
    });

    it('rejects users without Page access', async () => {
        mocks.userHasPageAccess.mockResolvedValue(false);
        const response = await GET(
            new Request('http://localhost/api/pages/page_1/chatbot/interruptions') as NextRequest,
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );
        expect(response.status).toBe(403);
    });
});
