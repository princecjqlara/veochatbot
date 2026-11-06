import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => mocks }));
import { processWorkspaceEvents } from '@/lib/veo-events';
import { veoEventReplay } from '@/lib/veo-event-context';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe('durable launch-period webhook processing', () => {
    it('retains failed events for retry while committing successful events and fences acknowledgments by attempt', async () => {
        vi.stubEnv('FACEBOOK_APP_SECRET', 'test-secret');
        const events = [{ event_key: 'success', attempts: 1, payload: { object: 'page', entry: [] } }, { event_key: 'retry', attempts: 2, payload: { object: 'page', entry: [] } }];
        mocks.rpc.mockResolvedValue({ data: events, error: null });
        const writes: any[] = [], predicates: any[] = [];
        mocks.from.mockImplementation(() => ({ update: (value: any) => {
            writes.push(value);
            const q: any = { eq: (key: string, value: any) => { predicates.push([key, value]); return q; }, then: (done: any) => Promise.resolve({ error: null }).then(done) };
            return q;
        } }));
        let calls = 0;
        const processed = await processWorkspaceEvents(async request => {
            expect(veoEventReplay.getStore()).toBe(true);
            expect(request.headers.get('x-hub-signature-256')).toMatch(/^sha256=/);
            return new Response('', { status: ++calls === 1 ? 200 : 503 });
        }, 'https://veo.test');
        expect(processed).toBe(2);
        expect(writes[0]).toMatchObject({ status: 'done', last_error: null });
        expect(writes[1]).toMatchObject({ status: 'queued', last_error: 'Event processing returned 503' });
        expect(predicates).toContainEqual(['attempts', 1]); expect(predicates).toContainEqual(['attempts', 2]);
        expect(veoEventReplay.getStore()).toBeUndefined();
    });
});
