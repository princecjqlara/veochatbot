import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), from: vi.fn(), signed: vi.fn(), rows: {} as Record<string, any[]>, failed: '' }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: m.session }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: m.access }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: m.from }) }));
vi.mock('@/lib/chatbot-media', async original => ({ ...await original<any>(), createChatbotMediaSignedUrl: m.signed }));
import { GET as knowledge } from './knowledge/route';
import { GET as folders } from './folders/route';
import { GET as media } from './media/route';
const request = () => new NextRequest('https://veo.test/api/pages/page/chatbot/knowledge'), context = { params: Promise.resolve({ pageId: 'page' }) };
beforeEach(() => {
    vi.clearAllMocks();m.rows = {};m.failed = '';m.session.mockResolvedValue({ user: { id: 'owner' } });m.access.mockResolvedValue(true);
    m.from.mockImplementation((table: string) => { const q: any = { select: () => q, eq: () => q, order: () => q, range: async (start: number, end: number) => m.failed === table ? { error: { message: 'offline' } } : { data: (m.rows[table] || []).slice(start, end + 1) } };return q; });
    m.signed.mockImplementation(async (asset: any) => 'preview-' + asset.id);
});
it('returns every knowledge document and Drive file past the API row cap', async () => {
    m.rows.chatbot_knowledge_documents = Array.from({ length: 1201 }, (_, i) => ({ id: 'doc-' + i }));
    m.rows.chatbot_drive_files = Array.from({ length: 1401 }, (_, i) => ({ id: 'file-' + i }));
    const docs = await knowledge(request(), context);expect((await docs.json()).documents).toHaveLength(1201);expect(docs.headers.get('Cache-Control')).toBe('no-store');
    const source = await folders(request(), context);expect((await source.json()).files).toHaveLength(1401);
});
it('keeps all media records in order while bounding preview generation', async () => {
    let active = 0, peak = 0;m.rows.chatbot_media_assets = Array.from({ length: 1101 }, (_, i) => ({ id: 'asset-' + i }));
    m.signed.mockImplementation(async (asset: any) => { active++;peak = Math.max(active, peak);await Promise.resolve();active--;return 'preview-' + asset.id; });
    const response = await media(request(), context), body = await response.json();
    expect(body.assets).toHaveLength(1101);expect(body.assets.at(-1)).toMatchObject({ id: 'asset-1100', preview_url: 'preview-asset-1100' });expect(peak).toBeLessThanOrEqual(8);
});
it('rejects unauthorized or unavailable source reads without returning empty success', async () => {
    m.access.mockResolvedValueOnce(false);expect((await knowledge(request(), context)).status).toBe(403);expect(m.from).not.toHaveBeenCalled();
    m.failed = 'chatbot_drive_files';const response = await folders(request(), context);expect(response.status).toBe(500);expect((await response.json()).files).toBeUndefined();
});
