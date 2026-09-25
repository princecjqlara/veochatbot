import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    userHasPageAccess: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    ingestChatbotKnowledge: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.getSessionFromRequest }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: mocks.userHasPageAccess }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/chatbot-knowledge', () => ({ ingestChatbotKnowledge: mocks.ingestChatbotKnowledge }));

import { POST } from './route';

const pageId = 'd3f40d05-aa54-498e-bff7-e9c4410b7471';

function post(body: unknown) {
    return new Request('http://localhost/api/pages/' + pageId + '/chatbot/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    }) as NextRequest;
}

describe('chatbot Drive folders route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'user_1' } });
        mocks.userHasPageAccess.mockResolvedValue(true);
        mocks.ingestChatbotKnowledge.mockResolvedValue({ id: 'document_1', chunk_count: 1 });
    });

    it('requires Page membership', async () => {
        mocks.userHasPageAccess.mockResolvedValue(false);
        const response = (await POST(post({}), { params: Promise.resolve({ pageId }) }))!;

        expect(response.status).toBe(403);
        expect(mocks.ingestChatbotKnowledge).not.toHaveBeenCalled();
    });

    it('rejects links that are not Google Drive folders', async () => {
        const response = (await POST(post({
            name: 'Samples',
            folder_url: 'https://example.com/files'
        }), { params: Promise.resolve({ pageId }) }))!;

        expect(response.status).toBe(400);
        expect(mocks.ingestChatbotKnowledge).not.toHaveBeenCalled();
    });

    it('indexes the folder name and saves a normalized customer button', async () => {
        const savedFolder = {
            id: 'folder_1',
            page_id: pageId,
            knowledge_document_id: 'document_1',
            name: 'Balayage Samples',
            folder_url: 'https://drive.google.com/drive/folders/abc_123',
            button_text: 'View samples'
        };
        const builder: Record<string, any> = {};
        builder.insert = vi.fn(() => builder);
        builder.select = vi.fn(() => builder);
        builder.single = vi.fn().mockResolvedValue({ data: savedFolder, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });

        const response = (await POST(post({
            name: 'Balayage Samples',
            folder_url: 'https://drive.google.com/drive/u/1/folders/abc_123?usp=sharing',
            usage_notes: 'Before and after samples for color inquiries.',
            button_text: 'View samples'
        }), { params: Promise.resolve({ pageId }) }))!;

        expect(response.status).toBe(201);
        expect(await response.json()).toEqual(expect.objectContaining({ folder: savedFolder }));
        expect(mocks.ingestChatbotKnowledge).toHaveBeenCalledWith(expect.objectContaining({
            pageId,
            userId: 'user_1',
            title: '[Drive folder] Balayage Samples',
            content: expect.stringContaining('GOOGLE DRIVE MEDIA FOLDER: Balayage Samples')
        }));
        expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({
            folder_url: 'https://drive.google.com/drive/folders/abc_123',
            button_text: 'View samples'
        }));
    });
});
