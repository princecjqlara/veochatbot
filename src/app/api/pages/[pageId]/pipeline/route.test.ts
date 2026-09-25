import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    userHasPageAccess: vi.fn(),
    updateContactPipelineStage: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.getSessionFromRequest }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: mocks.userHasPageAccess }));
vi.mock('@/lib/contact-pipeline', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/contact-pipeline')>();
    return { ...original, updateContactPipelineStage: mocks.updateContactPipelineStage };
});

import { GET, PATCH } from './route';

describe('pipeline Page-member access', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'collaborator_1' } });
        mocks.userHasPageAccess.mockResolvedValue(true);
        mocks.updateContactPipelineStage.mockResolvedValue(true);
    });

    it('lets any user_pages collaborator edit a contact stage', async () => {
        const builder: Record<string, any> = {};
        builder.select = vi.fn(() => builder);
        builder.eq = vi.fn(() => builder);
        builder.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'contact_1' }, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });

        const response = await PATCH(new Request('http://localhost/api/pages/page_1/pipeline', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact_id: 'contact_1', stage: 'qualified' })
        }) as NextRequest, { params: Promise.resolve({ pageId: 'page_1' }) });

        expect(response.status).toBe(200);
        expect(mocks.userHasPageAccess).toHaveBeenCalledWith('collaborator_1', 'page_1');
        expect(mocks.updateContactPipelineStage).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                pageId: 'page_1',
                contactId: 'contact_1',
                stage: 'qualified',
                source: 'manual',
                force: true
            })
        );
    });

    it('rejects a signed-in user without membership before reading pipeline data', async () => {
        mocks.userHasPageAccess.mockResolvedValue(false);

        const response = await GET(
            new Request('http://localhost/api/pages/page_1/pipeline') as NextRequest,
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(403);
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });
});
