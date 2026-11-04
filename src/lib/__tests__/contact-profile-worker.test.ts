import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.db }));
import { processContactProfiles, profileAnalysisChunk, profileSourceMessages, safeProfileCursor } from '@/lib/contact-profile-worker';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('local-only conversation profile processing', () => {
    it('never claims database jobs, refetches Meta history, or sends profile data to OpenRouter', async () => {
        vi.stubEnv('CONTACT_PROFILE_PROCESSING_MODE', 'remote');
        vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
        vi.stubGlobal('fetch', vi.fn());
        expect(await processContactProfiles({ limit: 1 })).toEqual({ processed: 0, ready: 0, failed: 0, mode: 'local' });
        expect(mocks.db).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('keeps chapter boundaries for local profile review', () => {
        const messages = Array.from({ length: 250 }, (_, index) => ({ id: String(index), at: new Date(index * 60000).toISOString(), sender: 'customer' as const, text: 'A'.repeat(200), attachments: 0 }));
        expect(profileAnalysisChunk(messages, 0).advance).toBe(100);
        expect(profileAnalysisChunk(messages, 100).advance).toBe(100);
    });
    it('validates history cursors and removes access tokens before storing them', () => {
        expect(safeProfileCursor('https://graph.facebook.com/thread/messages?after=abc&access_token=secret')).not.toContain('secret');
        for (const value of ['http://graph.facebook.com/thread/messages', 'https://evil.example/messages', 'https://graph.facebook.com/me/accounts']) expect(() => safeProfileCursor(value)).toThrow();
    });
    it('validates local source timestamps and distinguishes image attachments', () => {
        const source = [{ id: 'message', created_time: '2026-10-01T00:00:00Z', from: { id: 'buyer' }, message: 'Hello', attachments: { data: [{ mime_type: 'application/pdf' }, { mime_type: 'image/png' }] } }];
        expect(() => profileSourceMessages([{ ...source[0], created_time: 'invalid' }], 'fb-page', 'buyer', '2026-10-02')).toThrow();
        expect(profileSourceMessages(source, 'fb-page', 'buyer', '2026-10-02')[0]).toMatchObject({ sender: 'customer', attachments: 2, images: 1 });
        expect(profileSourceMessages(source, 'fb-page', 'buyer', '2026-09-01')).toHaveLength(0);
    });
});
