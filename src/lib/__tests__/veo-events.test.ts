import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => mocks }));
import { processWorkspaceEvents } from '@/lib/veo-events';
import { veoEventReplay } from '@/lib/veo-event-context';
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('durable launch-period webhook processing', () => {
    it('retains failed events for retry while committing successful events and fences acknowledgments by attempt', async () => {
        vi.stubEnv('FACEBOOK_APP_SECRET', 'test-secret');
        const events = [{ event_key: 'success', attempts: 1, payload: { object: 'page', entry: [] } }, { event_key: 'retry', attempts: 2, payload: { object: 'page', entry: [] } }];
        mocks.rpc.mockResolvedValueOnce({ data: events, error: null }).mockResolvedValue({ data: [], error: null });
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
    it('drains successive leases with at most four separate conversations in flight', async () => {
        vi.stubEnv('FACEBOOK_APP_SECRET', 'test-secret');
        const events = Array.from({ length: 45 }, (_, i) => ({ event_key: String(i), attempts: 1, payload: { object: 'page', entry: [] } }));
        mocks.rpc.mockResolvedValueOnce({ data: events.slice(0,20) }).mockResolvedValueOnce({ data: events.slice(20,40) }).mockResolvedValueOnce({ data: events.slice(40) }).mockResolvedValue({ data: [] });
        mocks.from.mockImplementation(() => { const q: any = { update: () => q, eq: () => q, then: (done: any) => Promise.resolve({ error: null }).then(done) }; return q; });
        let inFlight = 0, maximum = 0;
        const handler = vi.fn(async () => { inFlight++; maximum = Math.max(maximum, inFlight); await Promise.resolve(); inFlight--; return new Response(''); });
        expect(await processWorkspaceEvents(handler, 'https://veo.test')).toBe(45);
        expect(maximum).toBe(4); expect(handler).toHaveBeenCalledTimes(45); expect(mocks.rpc).toHaveBeenCalledTimes(4);
    });
    it('keeps a conversation serial even if a lease unexpectedly contains more than one of its events', async () => {
        vi.stubEnv('FACEBOOK_APP_SECRET', 'test-secret');
        const events = Array.from({ length: 6 }, (_, i) => ({ event_key: String(i), conversation_key: i < 4 ? 'same-client' : String(i), attempts: 1, payload: { id: i } }));
        mocks.rpc.mockResolvedValueOnce({ data: events }).mockResolvedValue({ data: [] });
        mocks.from.mockImplementation(() => { const q: any = { update: () => q, eq: () => q, then: (done: any) => Promise.resolve({ error: null }).then(done) }; return q; });
        const order: number[] = []; let active = 0, max = 0;
        expect(await processWorkspaceEvents(async request => {
            const { id } = await request.json();
            if (id < 4) { active++; max = Math.max(max, active); }
            await Promise.resolve();
            if (id < 4) { order.push(id); active--; }
            return new Response('');
        }, 'https://veo.test')).toBe(6);
        expect(order).toEqual([0,1,2,3]); expect(max).toBe(1);
    });
    it('releases the rest of a lease at the time limit without invoking their handler', async () => {
        vi.stubEnv('FACEBOOK_APP_SECRET', 'test-secret');
        let now = 0; vi.spyOn(Date, 'now').mockImplementation(() => now);
        mocks.rpc.mockResolvedValue({ data: [{ event_key: 'first', conversation_key: 'same', attempts: 2, payload: {} }, { event_key: 'release', conversation_key: 'same', attempts: 3, payload: {} }] });
        const writes: any[] = [];
        mocks.from.mockImplementation(() => { const q: any = { update: (value: any) => { writes.push(value); return q; }, eq: () => q, then: (done: any) => Promise.resolve({ error: null }).then(done) }; return q; });
        const handler = vi.fn(async () => { now = 210001; return new Response(''); });
        expect(await processWorkspaceEvents(handler, 'https://veo.test')).toBe(1);
        expect(handler).toHaveBeenCalledTimes(1); expect(mocks.rpc).toHaveBeenCalledTimes(1);
        expect(writes[1]).toEqual({ status: 'queued', lease_until: null });
    });
    it('caps a fast worker at 200 attempts so maintenance and handoffs keep their execution budget', async () => {
        vi.stubEnv('FACEBOOK_APP_SECRET', 'test-secret');
        mocks.rpc.mockResolvedValue({ data: Array.from({ length: 20 }, (_, i) => ({ event_key: String(i), attempts: 1, payload: {} })) });
        mocks.from.mockImplementation(() => { const q: any = { update: () => q, eq: () => q, then: (done: any) => Promise.resolve({ error: null }).then(done) }; return q; });
        const handler = vi.fn(async () => new Response(''));
        expect(await processWorkspaceEvents(handler, 'https://veo.test')).toBe(200);
        expect(mocks.rpc).toHaveBeenCalledTimes(10);
    });
});
